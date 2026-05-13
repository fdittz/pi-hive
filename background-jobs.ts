import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export interface BackgroundJob {
	id: string;
	agent: string;
	task: string;
	status: "running" | "completed" | "failed" | "cancelled";
	progress: number; // 0-100
	startedAt: string;
	completedAt?: string;
	result?: string;
	error?: string;
}

const JOBS_FILE = path.join(getAgentDir(), "background-jobs.json");
const JOB_RETENTION_MS = 60 * 60 * 1000; // 1 hour

function getJobsFilePath(): string {
	return JOBS_FILE;
}

function generateJobId(agent: string): string {
	return `bg_${agent}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function loadJobsFile(): Promise<BackgroundJob[]> {
	try {
		const content = await fs.promises.readFile(getJobsFilePath(), "utf8");
		const parsed = JSON.parse(content);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

async function saveJobsFile(jobs: BackgroundJob[]): Promise<void> {
	await withFileMutationQueue(getJobsFilePath(), async () => {
		const dir = path.dirname(getJobsFilePath());
		await fs.promises.mkdir(dir, { recursive: true });
		await fs.promises.writeFile(getJobsFilePath(), JSON.stringify(jobs, null, 2), "utf8");
	});
}

export async function queueBackgroundJob(agent: string, task: string): Promise<string> {
	const id = generateJobId(agent);
	const jobs = await loadJobsFile();
	const newJob: BackgroundJob = {
		id,
		agent,
		task,
		status: "running",
		progress: 0,
		startedAt: new Date().toISOString(),
	};
	jobs.push(newJob);
	await saveJobsFile(jobs);
	return id;
}

export async function getBackgroundJobs(): Promise<BackgroundJob[]> {
	let jobs = await loadJobsFile();
	
	// Filter and clean up
	const now = Date.now();
	const active: BackgroundJob[] = [];
	const recent: BackgroundJob[] = [];
	
	for (const job of jobs) {
		if (job.status === "running") {
			active.push(job);
		} else {
			const completedAt = job.completedAt ? new Date(job.completedAt).getTime() : 0;
			if (now - completedAt < JOB_RETENTION_MS) {
				recent.push(job);
			}
		}
	}
	
	// Keep last 10 completed
	const kept = [...active, ...recent.sort((a, b) => 
		new Date(b.completedAt || 0).getTime() - new Date(a.completedAt || 0).getTime()
	).slice(0, 10)];
	
	if (kept.length < jobs.length) {
		await saveJobsFile(kept);
	}
	
	return jobs.filter(j => j.status === "running" || j.status === "completed");
}

export async function updateJobProgress(id: string, progress: number): Promise<void> {
	const jobs = await loadJobsFile();
	const job = jobs.find(j => j.id === id);
	if (job) {
		job.progress = Math.min(100, Math.max(0, progress));
		await saveJobsFile(jobs);
	}
}

export async function completeJob(id: string, result: string): Promise<void> {
	const jobs = await loadJobsFile();
	const job = jobs.find(j => j.id === id);
	if (job) {
		job.status = "completed";
		job.progress = 100;
		job.completedAt = new Date().toISOString();
		job.result = result;
		await saveJobsFile(jobs);
	}
}

export async function failJob(id: string, error: string): Promise<void> {
	const jobs = await loadJobsFile();
	const job = jobs.find(j => j.id === id);
	if (job) {
		job.status = "failed";
		job.completedAt = new Date().toISOString();
		job.error = error;
		await saveJobsFile(jobs);
	}
}

export async function cancelJob(id: string): Promise<void> {
	const jobs = await loadJobsFile();
	const job = jobs.find(j => j.id === id);
	if (job && job.status === "running") {
		job.status = "cancelled";
		job.completedAt = new Date().toISOString();
		await saveJobsFile(jobs);
	}
}

export function formatRunningJobs(jobs: BackgroundJob[]): string {
	const running = jobs.filter(j => j.status === "running");
	if (running.length === 0) return "";
	
	const items = running.map(j => {
		const taskPreview = j.task.length > 25 ? j.task.slice(0, 22) + "..." : j.task;
		return `${j.agent} (${taskPreview}, ${j.progress}%)`;
	}).join(", ");
	
	return `⚙️  Running: ${items}`;
}
