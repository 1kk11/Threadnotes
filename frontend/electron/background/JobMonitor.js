const { Notification, app } = require('electron');
const path = require('path');

const isDev = !app.isPackaged;
const API_URL = "https://threadnotes-backend-ih96.onrender.com";

class JobMonitor {
    constructor(store) {
        this.store = store;
        this.activeJobs = new Map();
        this.timers = new Map();
        this.isPaused = false;
        this.authPaused = false;
        this.onJobCompleted = null;
        this.iconPath = path.join(__dirname, "..", "..", "build", "icon.ico");

        this.loadPersistedJobs();
    }

    addTimelineEvent(meetingId, event, context = {}) {
        const jobData = this.activeJobs.get(meetingId);
        if (!jobData) return;
        
        jobData.timeline.push({
            time: new Date().toISOString(),
            event: event,
            ...context
        });
        
        // Retain only the most recent 100 events
        if (jobData.timeline.length > 100) {
            jobData.timeline = jobData.timeline.slice(-100);
        }
        
        this.savePersistedJobs();
    }

    loadPersistedJobs() {
        const jobs = this.store.get('activeJobs', {});
        for (const [meetingId, jobData] of Object.entries(jobs)) {
            // Automatic Schema Migration to v2
            if (!jobData.schemaVersion || jobData.schemaVersion < 2) {
                jobData.schemaVersion = 2;
                
                // Convert old string timeline to structured objects
                if (Array.isArray(jobData.timeline)) {
                    jobData.timeline = jobData.timeline.map(item => {
                        if (typeof item === 'string') {
                            return {
                                time: new Date().toISOString(),
                                event: "LEGACY_EVENT",
                                message: item
                            };
                        }
                        return item;
                    });
                } else {
                    jobData.timeline = [];
                }
                
                if (!jobData.failCount) jobData.failCount = 0;
                if (!jobData.lastStatus) jobData.lastStatus = jobData.status || 'PROCESSING';
                jobData.lastSuccessfulPoll = null;
                jobData.lastResponse = null;
                jobData.status = 'MONITORING';
            }
            
            this.activeJobs.set(meetingId, jobData);
            this.schedulePoll(meetingId, 1000 + Math.random() * 2000); // schedule initial poll on load quickly
        }
    }

    savePersistedJobs() {
        const jobsObj = Object.fromEntries(this.activeJobs);
        this.store.set('activeJobs', jobsObj);
    }

    registerJob(meetingId, topic) {
        if (this.activeJobs.has(meetingId)) return;

        const jobData = {
            schemaVersion: 2,
            meetingId,
            topic: topic || 'Meeting',
            startedAt: Date.now(),
            status: 'MONITORING',
            lastStatus: 'PROCESSING',
            lastSuccessfulPoll: null,
            lastResponse: null,
            failCount: 0,
            nextPollAt: null,
            timeline: []
        };

        this.activeJobs.set(meetingId, jobData);
        this.savePersistedJobs();
        
        this.addTimelineEvent(meetingId, "JOB_REGISTERED");
        console.log(`[JobMonitor][${meetingId}] Job Registered: ${jobData.topic}`);
        
        this.schedulePoll(meetingId, 10000); // Wait 10s before first poll
    }

    unregisterJob(meetingId) {
        if (this.timers.has(meetingId)) {
            clearTimeout(this.timers.get(meetingId));
            this.timers.delete(meetingId);
        }
        if (this.activeJobs.has(meetingId)) {
            this.addTimelineEvent(meetingId, "JOB_REMOVED");
            console.log(`[JobMonitor][${meetingId}] Job Removed`);
            this.activeJobs.delete(meetingId);
            this.savePersistedJobs();
        }
    }

    getActiveJobs() {
        return Array.from(this.activeJobs.values());
    }

    pauseAll(isAuthError = false) {
        this.isPaused = true;
        if (isAuthError) this.authPaused = true;
        
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        
        console.log(`[JobMonitor] Paused all polling${isAuthError ? ' (Auth Error)' : ''}`);
        
        for (const meetingId of this.activeJobs.keys()) {
            this.addTimelineEvent(meetingId, "SUSPEND", { 
                reason: isAuthError ? "AUTH_ERROR" : "SYSTEM_OR_MANUAL" 
            });
        }
    }

    resumeAll() {
        if (this.authPaused) return; // Do not resume on wake if auth is expired
        if (!this.isPaused) return;
        this.isPaused = false;
        
        console.log(`[JobMonitor] Resuming all polling`);
        
        for (const meetingId of this.activeJobs.keys()) {
            this.addTimelineEvent(meetingId, "RESUME");
            // Schedule with a tiny random delay to avoid thunderous herd on wake
            this.schedulePoll(meetingId, Math.random() * 2000);
        }
    }

    stopAll() {
        this.pauseAll();
    }

    onTokenUpdated() {
        if (this.authPaused) {
            this.authPaused = false;
            console.log(`[JobMonitor] Token updated, recovering from auth pause`);
            this.resumeAll();
        }
    }

    getPollingInterval(startedAt) {
        const runningTimeMs = Date.now() - startedAt;
        if (runningTimeMs < 60 * 1000) return 10000; // < 1m -> 10s
        if (runningTimeMs < 3 * 60 * 1000) return 30000; // < 3m -> 30s
        if (runningTimeMs < 10 * 60 * 1000) return 60000; // < 10m -> 60s
        return 120000; // Else -> 2m
    }

    schedulePoll(meetingId, delayMs = null) {
        if (this.isPaused) return;

        const jobData = this.activeJobs.get(meetingId);
        if (!jobData) return;

        const interval = delayMs !== null ? delayMs : this.getPollingInterval(jobData.startedAt);
        jobData.nextPollAt = new Date(Date.now() + interval).toISOString();
        this.savePersistedJobs();

        if (this.timers.has(meetingId)) {
            clearTimeout(this.timers.get(meetingId));
        }

        const timerId = setTimeout(() => this.pollJob(meetingId), interval);
        this.timers.set(meetingId, timerId);
    }

    async pollJob(meetingId) {
        if (this.isPaused) return;

        const jobData = this.activeJobs.get(meetingId);
        if (!jobData) return;

        this.addTimelineEvent(meetingId, "POLL_STARTED");
        console.log(`[JobMonitor][${meetingId}] Poll started. Fail count: ${jobData.failCount}`);

        const token = this.store.get('jwt_token');
        if (!token) {
            this.addTimelineEvent(meetingId, "AUTH_MISSING");
            console.warn(`[JobMonitor][${meetingId}] No token available, will retry later`);
            this.schedulePoll(meetingId, 60000); 
            return;
        }

        try {
            const res = await fetch(`${API_URL}/jobs/${meetingId}/progress`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });

            if (res.status === 401 || res.status === 403) {
                this.addTimelineEvent(meetingId, "AUTH_ERROR", { statusCode: res.status });
                console.warn(`[JobMonitor][${meetingId}] 401/403 Unauthorized, pausing all jobs.`);
                this.pauseAll(true); 
                return;
            }

            if (!res.ok) {
                if (res.status === 404) {
                    this.addTimelineEvent(meetingId, "JOB_FAILED", { error: "Job not found on server (404)" });
                    console.error(`[JobMonitor][${meetingId}] 404 Not Found, failing job immediately.`);
                    this.handleJobFailed(meetingId, { error: "Job not found on server (404)" });
                    return;
                }
                throw new Error(`HTTP ${res.status}`);
            }

            // On success, reset fail count
            jobData.failCount = 0;
            jobData.lastSuccessfulPoll = new Date().toISOString();

            const data = await res.json();
            
            const tChunks = data.total_chunks || 0;
            const cChunks = data.completed_chunks || 0;
            const pct = tChunks > 0 ? Math.round((cChunks / tChunks) * 100) : 0;
            
            const fetchedStatus = data.job_status || data.status || 'PROCESSING';

            jobData.lastResponse = {
                status: fetchedStatus,
                completedChunks: cChunks,
                processingChunks: data.processing_chunks || 0,
                failedChunks: data.failed_chunks || 0,
                totalChunks: tChunks,
                progress: pct
            };

            // Detect status transition
            if (jobData.lastStatus !== fetchedStatus) {
                this.addTimelineEvent(meetingId, "STATUS_CHANGED", {
                    from: jobData.lastStatus,
                    to: fetchedStatus
                });
                console.log(`[JobMonitor][${meetingId}] Status changed: ${jobData.lastStatus} -> ${fetchedStatus}`);
                jobData.lastStatus = fetchedStatus;
            }
            
            if (fetchedStatus === 'COMPLETED') {
                this.handleJobCompleted(meetingId, data);
            } else if (fetchedStatus === 'FAILED') {
                this.addTimelineEvent(meetingId, "JOB_FAILED", { error: data.error });
                console.error(`[JobMonitor][${meetingId}] Backend reported FAILED status: ${data.error || 'Unknown error'}`);
                this.handleJobFailed(meetingId, data);
            } else {
                this.schedulePoll(meetingId);
            }

        } catch (err) {
            jobData.failCount = (jobData.failCount || 0) + 1;
            
            const errorReason = err.code || err.message || "UNKNOWN_ERROR";
            this.addTimelineEvent(meetingId, "NETWORK_ERROR", { 
                error: errorReason,
                failCount: jobData.failCount
            });
            console.error(`[JobMonitor][${meetingId}] Network Error: ${errorReason}. Backing off...`);
            
            // Exponential backoff: 30s, 1m, 2m, 4m, max 10m
            const backoff = Math.min(30000 * Math.pow(2, jobData.failCount - 1), 600000);
            this.schedulePoll(meetingId, backoff);
        }
    }

    handleJobCompleted(meetingId, data) {
        const jobData = this.activeJobs.get(meetingId);
        const topic = jobData ? jobData.topic : (data.topic || 'Meeting');

        this.addTimelineEvent(meetingId, "NOTIFICATION_SHOWN");
        console.log(`[JobMonitor][${meetingId}] Showing completed notification`);

        const notification = new Notification({
            title: '✅ Meeting Ready',
            body: `${topic}\nClick to open transcript.`,
            icon: this.iconPath
        });

        notification.on('click', () => {
            if (this.onJobCompleted) {
                this.onJobCompleted(meetingId);
            }
        });

        notification.show();
        this.unregisterJob(meetingId);
    }

    async handleJobFailed(meetingId, data) {
        const jobData = this.activeJobs.get(meetingId);
        const topic = jobData ? jobData.topic : (data.topic || 'Meeting');
        const errorMessage = data.error || 'Unknown error occurred in processing';

        this.addTimelineEvent(meetingId, "NOTIFICATION_SHOWN", { type: "error" });
        console.log(`[JobMonitor][${meetingId}] Showing failed notification`);

        const notification = new Notification({
            title: '❌ Processing Failed',
            body: `${topic}\nError: ${errorMessage}`,
            icon: this.iconPath
        });

        await this.updateLocalMeeting(meetingId, {
            status: 'FAILED',
            error: errorMessage
        });

        notification.show();
        this.unregisterJob(meetingId);
    }
}

module.exports = JobMonitor;
