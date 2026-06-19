from fastapi import FastAPI, UploadFile, File, Form, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer
from pydantic import BaseModel, EmailStr
from typing import Optional, Dict
import uvicorn
import os
import tempfile
import pathlib
import uuid
import bcrypt
import jwt
import random
import smtplib
import shutil
import time
import subprocess
import glob
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timezone, timedelta
from azure.cosmos import CosmosClient
from dotenv import load_dotenv
from concurrent.futures import ThreadPoolExecutor, as_completed

load_dotenv()

COSMOS_ENDPOINT = os.getenv("COSMOS_ENDPOINT")
COSMOS_KEY = os.getenv("COSMOS_KEY")
DATABASE_NAME = os.getenv("COSMOS_DATABASE")
USERS_CONTAINER = os.getenv("COSMOS_USERS_CONTAINER", "users")

SECRET_KEY = os.getenv("JWT_SECRET", "threadnotes-super-secret-key")
ALGORITHM = "HS256"

MAX_WORKERS = int(os.getenv("MAX_WORKERS", 6))

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login")
client = CosmosClient(COSMOS_ENDPOINT, COSMOS_KEY)
database = client.get_database_client(DATABASE_NAME)
users_cont = database.get_container_client(USERS_CONTAINER)

progress_tracker: Dict[str, Dict[str, int]] = {}
otp_storage: Dict[str, str] = {}         
signup_otp_storage: Dict[str, str] = {}  

class UserSignup(BaseModel):
    name: str
    email: EmailStr
    password: str

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class OTPRequest(BaseModel):
    email: EmailStr

class OTPVerifyRequest(BaseModel):
    email: EmailStr
    otp: str

class ForgotPasswordRequest(BaseModel):
    email: EmailStr

class ResetPasswordRequest(BaseModel):
    email: EmailStr
    otp: str
    new_password: str

def send_otp_email(target_email: str, otp: str, subject_prefix: str):
    sender_email = os.getenv("EMAIL_SENDER")
    sender_password = os.getenv("EMAIL_PASSWORD")
    
    if not sender_email or not sender_password:
        raise HTTPException(status_code=500, detail="Email configuration missing in backend")

    msg = MIMEMultipart()
    msg['From'] = sender_email
    msg['To'] = target_email
    msg['Subject'] = f"ThreadNotes - {subject_prefix} OTP"
    body = f"Your OTP for {subject_prefix} is: {otp}\n\nPlease do not share this with anyone."
    msg.attach(MIMEText(body, 'plain'))
    
    try:
        server = smtplib.SMTP('smtp.gmail.com', 587)
        server.starttls()
        server.login(sender_email, sender_password)
        server.send_message(msg)
        server.quit()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to send email: {str(e)}")

from transcriber import Transcriber
from thick_client import router as thick_client_router

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Thick-client routes: GET /azure/token, POST /diarize/stream
app.include_router(thick_client_router)

@app.post("/send-signup-otp")
def send_signup_otp(req: OTPRequest):
    query = "SELECT * FROM c WHERE c.email = @email"
    params = [{"name": "@email", "value": req.email}]
    exists = list(users_cont.query_items(query, parameters=params, enable_cross_partition_query=True))
    if exists:
        raise HTTPException(status_code=400, detail="Email already registered. Please log in.")

    otp = str(random.randint(100000, 999999))
    signup_otp_storage[req.email] = otp
    send_otp_email(req.email, otp, "Signup Verification")
    return {"status": "success", "message": "Verification OTP sent successfully."}

@app.post("/verify-signup-otp")
def verify_signup_otp(req: OTPVerifyRequest):
    if signup_otp_storage.get(req.email) != req.otp:
        raise HTTPException(status_code=400, detail="Invalid or expired verification OTP")
    return {"status": "success", "message": "Email verified successfully."}

@app.post("/signup")
def signup(user: UserSignup):
    query = "SELECT * FROM c WHERE c.email = @email"
    exists = list(users_cont.query_items(query, parameters=[{"name": "@email", "value": user.email}], enable_cross_partition_query=True))
    if exists: raise HTTPException(status_code=400, detail="Email already registered")

    hashed_pw = bcrypt.hashpw(user.password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    user_doc = {
        "id": str(uuid.uuid4()), "tenantId": str(uuid.uuid4()), "name": user.name,
        "email": user.email, "password": hashed_pw, "createdAt": datetime.now(timezone.utc).isoformat()
    }
    users_cont.create_item(user_doc)
    signup_otp_storage.pop(user.email, None) 
    return {"status": "success", "message": "Account created"}

@app.post("/login")
def login(user: UserLogin):
    query = "SELECT * FROM c WHERE c.email = @email"
    user_list = list(users_cont.query_items(query, parameters=[{"name": "@email", "value": user.email}], enable_cross_partition_query=True))
    if not user_list or not bcrypt.checkpw(user.password.encode('utf-8'), user_list[0]['password'].encode('utf-8')):
        raise HTTPException(status_code=401, detail="Invalid credentials")

    token_data = {"sub": user_list[0]['email'], "tenantId": user_list[0]['tenantId'], "exp": datetime.utcnow() + timedelta(hours=24)}
    return {"access_token": jwt.encode(token_data, SECRET_KEY, algorithm=ALGORITHM), "token_type": "bearer", "name": user_list[0]['name']}

@app.post("/forgot-password")
def forgot_password(req: ForgotPasswordRequest):
    user_list = list(users_cont.query_items("SELECT * FROM c WHERE c.email = @email", parameters=[{"name": "@email", "value": req.email}], enable_cross_partition_query=True))
    if not user_list: return {"status": "success", "message": "If email exists, OTP sent."}

    otp = str(random.randint(100000, 999999))
    otp_storage[req.email] = otp
    send_otp_email(req.email, otp, "Password Reset")
    return {"status": "success", "message": "OTP sent successfully."}

@app.post("/reset-password")
def reset_password(req: ResetPasswordRequest):
    if otp_storage.get(req.email) != req.otp: raise HTTPException(status_code=400, detail="Invalid or expired OTP")
    
    user_list = list(users_cont.query_items("SELECT * FROM c WHERE c.email = @email", parameters=[{"name": "@email", "value": req.email}], enable_cross_partition_query=True))
    if not user_list: raise HTTPException(status_code=404, detail="User not found")
        
    user_doc = user_list[0]
    user_doc['password'] = bcrypt.hashpw(req.new_password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    users_cont.upsert_item(user_doc)
    otp_storage.pop(req.email, None) 
    return {"status": "success", "message": "Password updated successfully!"}

@app.get("/progress/{filename}")
async def get_progress(filename: str):
    return progress_tracker.get(filename, {"current": 0, "total": 0})

@app.post("/transcribe")
def process_meeting(file: UploadFile = File(...), meeting_type: str = Form("General")):
    tmp_path = None
    filename = file.filename
    progress_tracker[filename] = {"current": 0, "total": 1}
    
    try:
        file_ext = pathlib.Path(filename.lower()).suffix
        audio_exts = {'.mp3', '.wav', '.webm', '.m4a', '.mpeg', '.mp4'}
        doc_exts = {'.docx', '.txt'}

        if file_ext in audio_exts:
            with tempfile.NamedTemporaryFile(delete=False, suffix=file_ext) as tmp:
                shutil.copyfileobj(file.file, tmp)
                tmp_path = tmp.name
            
            chunk_dir = tempfile.mkdtemp()
            chunk_pattern = os.path.join(chunk_dir, f"chunk_%04d{file_ext}")
            
            cmd = ["ffmpeg", "-y", "-i", tmp_path, "-vn", "-c:a", "copy", "-f", "segment", "-segment_time", "60", "-reset_timestamps", "1", chunk_pattern]
            process_bg = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            ts = Transcriber() 
            transcript_parts = {} 
            processed_chunks = set()
            active_futures = {}

            def process_single_chunk(idx, chunk_path):
                max_retries = 4
                backoff_time = 2
                for attempt in range(max_retries):
                    try:
                        text = ts.transcribe_audio_file(chunk_path)
                        if os.path.exists(chunk_path): 
                            os.remove(chunk_path)
                        return idx, text
                    except Exception as e:
                        if attempt < max_retries - 1:
                            print(f"Network drop on chunk {idx}. Retrying in {backoff_time}s... (Attempt {attempt + 1}/{max_retries})")
                            time.sleep(backoff_time)
                            backoff_time *= 2
                        else:
                            if os.path.exists(chunk_path): 
                                os.remove(chunk_path)
                            return idx, "\n[Transcription missing for this part due to extreme network failure]\n"

            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
                while process_bg.poll() is None:
                    current_chunks = sorted(glob.glob(os.path.join(chunk_dir, f"chunk_*{file_ext}")))
                    progress_tracker[filename]["total"] = max(1, len(current_chunks))

                    safe_chunks = current_chunks[:-1] if len(current_chunks) > 0 else []
                    
                    for chunk_path in safe_chunks:
                        if chunk_path not in processed_chunks:
                            idx = int(os.path.basename(chunk_path).split('_')[1].split('.')[0])
                            future = executor.submit(process_single_chunk, idx, chunk_path)
                            active_futures[future] = idx
                            processed_chunks.add(chunk_path)
                    
                    progress_tracker[filename]["current"] = sum(1 for f in active_futures.keys() if f.done())
                    time.sleep(0.5)

                current_chunks = sorted(glob.glob(os.path.join(chunk_dir, f"chunk_*{file_ext}")))
                progress_tracker[filename]["total"] = max(1, len(current_chunks))
                
                for chunk_path in current_chunks:
                    if chunk_path not in processed_chunks:
                        idx = int(os.path.basename(chunk_path).split('_')[1].split('.')[0])
                        future = executor.submit(process_single_chunk, idx, chunk_path)
                        active_futures[future] = idx
                        processed_chunks.add(chunk_path)

                for future in as_completed(active_futures.keys()):
                    idx, text = future.result()
                    if text: 
                        transcript_parts[idx] = text
                    progress_tracker[filename]["current"] = sum(1 for f in active_futures.keys() if f.done())
                        
            final_text = "\n\n".join(transcript_parts[i].strip() for i in sorted(transcript_parts.keys()) if transcript_parts[i].strip())
            progress_tracker.pop(filename, None)
            
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)
            if os.path.exists(chunk_dir):
                shutil.rmtree(chunk_dir, ignore_errors=True)

            return {"status": "success", "meeting_type": meeting_type, "transcript": final_text}

        elif file_ext in doc_exts:
            content = file.file.read()
            if file_ext == '.docx':
                from docx import Document
                doc = Document(io.BytesIO(content))
                text = " ".join([p.text for p in doc.paragraphs if p.text.strip()])
            else:
                text = content.decode('utf-8', errors='ignore')
            return {"status": "success", "meeting_type": meeting_type, "transcript": text}
        return {"status": "error", "message": "Unsupported format"}

    except Exception as e:
        progress_tracker.pop(filename, None)
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)
        return {"status": "error", "message": str(e)}

# Live transcription now runs in the browser via the Azure Speech SDK; the final
# diarized pass is handled by POST /diarize/stream (see thick_client.py). The old
# server-side WebSocket pipeline has been retired.

if __name__ == "__main__":
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
