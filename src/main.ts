import { App, ItemView, Modal, Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { spawn } from 'child_process';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { DEFAULT_SETTINGS, OtooracleSettings, OtooracleSettingTab } from './settings';

export const VIEW_TYPE = 'otoracle-dashboard';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface RunRow {
	id: string;
	command: string;
	manifest_path: string | null;
	dry_run: number;
	status: string;
	error: string | null;
	created_at: string;
}

interface RunSummary {
	run_id: string;
	sources: Record<string, number>;
	dead_letters: number;
	unresolved_links: number;
}

interface RunDetail {
	run: RunRow;
	summary: RunSummary;
	dead_letters: Array<{ id: number; stage: string; error: string; retried: number }>;
}

// ─── Dashboard View ─────────────────────────────────────────────────────────────

export class OtoracleDashboardView extends ItemView {
	plugin: OtoraclePipelinePlugin;
	private refreshTimer: ReturnType<typeof setInterval> | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: OtoraclePipelinePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string { return VIEW_TYPE; }
	getDisplayText(): string { return 'Otoracle Pipeline'; }
	getIcon(): string { return 'activity'; }

	async onOpen(): Promise<void> {
		await this.render();
		this.scheduleAutoRefresh();
	}

	async onClose(): Promise<void> {
		this.clearAutoRefresh();
	}

	private scheduleAutoRefresh(): void {
		this.clearAutoRefresh();
		const sec = this.plugin.settings.autoRefreshSec;
		if (sec > 0) {
			this.refreshTimer = setInterval(() => this.render(), sec * 1000);
		}
	}

	private clearAutoRefresh(): void {
		if (this.refreshTimer !== null) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	async render(): Promise<void> {
		const root = this.containerEl.children[1] as HTMLElement;
		const prevScroll = root.scrollTop;
		root.empty();

		// Header
		const header = root.createDiv('otoracle-header');
		header.createEl('h4', { text: 'Otoracle Pipeline' });

		const actions = header.createDiv('otoracle-actions');

		const refreshBtn = actions.createEl('button', { cls: 'otoracle-btn', text: '↺' });
		refreshBtn.title = 'Refresh';
		refreshBtn.addEventListener('click', () => this.render());

		const ingestBtn = actions.createEl('button', { cls: 'otoracle-btn primary', text: '+ Ingest' });
		ingestBtn.addEventListener('click', () => new ManifestPickerModal(this.app, this.plugin, this).open());

		const reconcileBtn = actions.createEl('button', { cls: 'otoracle-btn', text: '⇄ Reconcile' });
		reconcileBtn.title = 'Reconcile all unresolved wikilinks';
		reconcileBtn.addEventListener('click', () => this.reconcileAll());

		// Body
		const body = root.createDiv('otoracle-body');

		let runs: RunRow[] = [];
		try {
			const raw = await this.plugin.runPipelineCmd(['status']);
			runs = (JSON.parse(raw) as { runs: RunRow[] }).runs ?? [];
		} catch (err) {
			body.createEl('p', { text: `Error loading runs: ${err}`, cls: 'otoracle-error' });
			root.scrollTop = prevScroll;
			return;
		}

		if (runs.length === 0) {
			body.createEl('p', { text: 'No pipeline runs yet. Click + Ingest to begin.', cls: 'otoracle-empty' });
		} else {
			this.buildTable(body, runs);
		}

		root.scrollTop = prevScroll;
	}

	private buildTable(container: HTMLElement, runs: RunRow[]): void {
		const table = container.createEl('table', { cls: 'otoracle-table' });
		const tr = table.createEl('thead').createEl('tr');
		for (const h of ['Run ID', 'Status', 'Published', 'Failed', 'Dead', 'Links', 'Started', '']) {
			tr.createEl('th', { text: h });
		}

		const tbody = table.createEl('tbody');

		for (const run of runs) {
			const row = tbody.createEl('tr');

			row.createEl('td', { text: run.id, cls: 'mono' });

			const statusTd = row.createEl('td');
			statusTd.createEl('span', {
				text: run.status.replace(/_/g, ' '),
				cls: `otoracle-badge ${run.status}`,
			});

			// Count cells — populated when Details is loaded
			const publishedTd = row.createEl('td', { cls: 'num', text: '—' });
			const failedTd    = row.createEl('td', { cls: 'num', text: '—' });
			const deadTd      = row.createEl('td', { cls: 'num', text: '—' });
			const linksTd     = row.createEl('td', { cls: 'num', text: '—' });

			row.createEl('td', { text: fmtTime(run.created_at), cls: 'time' });

			const actionTd = row.createEl('td', { cls: 'actions' });
			const detailsBtn = actionTd.createEl('button', { cls: 'otoracle-btn sm', text: 'Details' });

			let expanded = false;
			let detailRow: HTMLTableRowElement | null = null;

			detailsBtn.addEventListener('click', async () => {
				if (expanded && detailRow) {
					detailRow.remove();
					detailRow = null;
					expanded = false;
					detailsBtn.textContent = 'Details';
					return;
				}

				detailsBtn.textContent = '…';
				detailsBtn.disabled = true;

				try {
					const raw = await this.plugin.runPipelineCmd(['status', '--run-id', run.id]);
					const detail = JSON.parse(raw) as RunDetail;
					const s = detail.summary;

					publishedTd.textContent = String(s.sources['published'] ?? 0);
					failedTd.textContent    = String(s.sources['failed']    ?? 0);
					deadTd.textContent      = String(s.dead_letters);
					linksTd.textContent     = String(s.unresolved_links);

					const rowIndex = Array.from(tbody.rows).indexOf(row);
					detailRow = tbody.insertRow(rowIndex + 1);
					detailRow.classList.add('otoracle-detail-row');
					const cell = detailRow.insertCell();
					cell.colSpan = 8;
					this.buildDetailBox(cell, detail);

					expanded = true;
					detailsBtn.textContent = 'Close';
				} catch (e) {
					new Notice(`Failed to load run details: ${e}`);
					detailsBtn.textContent = 'Details';
				} finally {
					detailsBtn.disabled = false;
				}
			});
		}
	}

	private buildDetailBox(cell: HTMLElement, detail: RunDetail): void {
		const box = cell.createDiv('otoracle-detail-box');
		const { run, summary, dead_letters } = detail;

		// Source breakdown badges
		const srcRow = box.createDiv('otoracle-row');
		srcRow.createEl('strong', { text: 'Sources:' });
		for (const [status, count] of Object.entries(summary.sources)) {
			srcRow.createEl('span', {
				text: `${status} ${count}`,
				cls: `otoracle-badge ${status}`,
			});
		}

		// Stats
		const statsRow = box.createDiv('otoracle-row');
		statsRow.createEl('span', { text: `Dead letters: ${summary.dead_letters}`, cls: 'otoracle-stat' });
		statsRow.createEl('span', { text: `Unresolved links: ${summary.unresolved_links}`, cls: 'otoracle-stat' });

		// Dead letters list
		if (dead_letters.length > 0) {
			box.createEl('p', { text: 'Dead letters:', cls: 'otoracle-subsection' });
			const ul = box.createEl('ul', { cls: 'otoracle-dl-list' });
			for (const d of dead_letters) {
				ul.createEl('li', { text: `[${d.stage}] ${d.error}` });
			}
		}

		// Manifest path
		if (run.manifest_path) {
			const mpRow = box.createDiv('otoracle-row');
			mpRow.createEl('strong', { text: 'Manifest:' });
			mpRow.createEl('code', { text: run.manifest_path });
		}

		// Run-level error
		if (run.error) {
			box.createEl('p', { text: `Error: ${run.error}`, cls: 'otoracle-error' });
		}

		// Retry button for failed runs
		if (run.status === 'failed' || run.status === 'partial_failed') {
			const retryBtn = box.createEl('button', { cls: 'otoracle-btn danger', text: '↺ Retry Failed' });
			retryBtn.addEventListener('click', async () => {
				retryBtn.disabled = true;
				retryBtn.textContent = 'Retrying…';
				try {
					await this.plugin.runPipelineCmd(['retry', '--run-id', run.id]);
					new Notice(`Retry queued for run ${run.id}`);
					await this.render();
				} catch (e) {
					new Notice(`Retry failed: ${e}`);
					retryBtn.textContent = '↺ Retry Failed';
					retryBtn.disabled = false;
				}
			});
		}
	}

	async reconcileAll(): Promise<void> {
		new Notice('Reconciling unresolved links…');
		try {
			const raw = await this.plugin.runPipelineCmd(['reconcile-links', '--scope', 'all']);
			const result = JSON.parse(raw) as { resolved?: number };
			new Notice(`Reconciled: ${result.resolved ?? 0} link(s) resolved`);
			await this.render();
		} catch (e) {
			new Notice(`Reconcile failed: ${e}`);
		}
	}

	async runIngest(manifestPath: string, dryRun: boolean): Promise<void> {
		const args = dryRun
			? ['dry-run', '--manifest', manifestPath]
			: ['ingest', '--manifest', manifestPath];

		new Notice(dryRun ? `Dry-run: ${manifestPath}` : `Ingesting: ${manifestPath}`);

		try {
			const raw = await this.plugin.runPipelineCmd(args);
			const result = JSON.parse(raw) as { summary?: { sources?: Record<string, number> } };
			const sources = result.summary?.sources ?? {};
			if (dryRun) {
				new Notice('Dry-run complete — no files published');
			} else {
				const published = sources['published'] ?? 0;
				const failed    = sources['failed']    ?? 0;
				new Notice(`Ingest complete — ${published} published, ${failed} failed`);
			}
			await this.render();
		} catch (e) {
			new Notice(`Ingest failed: ${e}`);
		}
	}
}

// ─── Manifest Picker Modal ──────────────────────────────────────────────────────

class ManifestPickerModal extends Modal {
	plugin: OtoraclePipelinePlugin;
	view: OtoracleDashboardView;

	constructor(app: App, plugin: OtoraclePipelinePlugin, view: OtoracleDashboardView) {
		super(app);
		this.plugin = plugin;
		this.view = view;
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Run Ingest' });

		const pathInput = contentEl.createEl('input', {
			type: 'text',
			cls: 'otoracle-input',
			attr: { placeholder: 'Absolute path to manifest CSV or JSON' },
		});

		// List manifests from the pipeline's data/manifests directory
		const manifestsDir = join(this.plugin.settings.pipelineDir, 'data', 'manifests');
		try {
			const entries = await readdir(manifestsDir);
			const manifests = entries.filter(f => f.endsWith('.csv') || f.endsWith('.json'));
			if (manifests.length > 0) {
				contentEl.createEl('p', { text: 'Recent manifests:', cls: 'otoracle-label' });
				const ul = contentEl.createEl('ul', { cls: 'otoracle-file-list' });
				for (const f of manifests) {
					const fullPath = join(manifestsDir, f);
					const li = ul.createEl('li');
					const a = li.createEl('a', { text: f, href: '#' });
					a.addEventListener('click', e => {
						e.preventDefault();
						pathInput.value = fullPath;
					});
				}
			}
		} catch {
			// Directory doesn't exist yet — skip
		}

		const dryLabel = contentEl.createEl('label', { cls: 'otoracle-check-label' });
		const dryCheck = dryLabel.createEl('input', { type: 'checkbox' });
		dryLabel.createSpan({ text: ' Dry-run — validate pipeline without publishing' });

		const footer = contentEl.createDiv('otoracle-modal-footer');
		const runBtn    = footer.createEl('button', { cls: 'otoracle-btn primary', text: 'Run' });
		const cancelBtn = footer.createEl('button', { cls: 'otoracle-btn', text: 'Cancel' });

		cancelBtn.addEventListener('click', () => this.close());

		runBtn.addEventListener('click', () => {
			const path = pathInput.value.trim();
			if (!path) { new Notice('Enter a manifest path'); return; }
			this.close();
			this.view.runIngest(path, dryCheck.checked);
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
	const d = new Date(iso);
	return (
		d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
		' ' +
		d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	);
}

// ─── Plugin ────────────────────────────────────────────────────────────────────

export default class OtoraclePipelinePlugin extends Plugin {
	settings: OtooracleSettings;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE, leaf => new OtoracleDashboardView(leaf, this));

		this.addRibbonIcon('activity', 'Otoracle Pipeline', () => this.openDashboard());

		this.addCommand({
			id: 'open-dashboard',
			name: 'Open dashboard',
			callback: () => this.openDashboard(),
		});

		this.addCommand({
			id: 'reconcile-links',
			name: 'Reconcile all unresolved links',
			callback: async () => {
				const view = this.getDashboardView();
				if (view) {
					await view.reconcileAll();
				} else {
					new Notice('Open the Otoracle dashboard first');
				}
			},
		});

		this.addSettingTab(new OtooracleSettingTab(this.app, this));
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE);
	}

	async openDashboard(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		const first = existing[0];
		if (first) {
			this.app.workspace.revealLeaf(first);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	getDashboardView(): OtoracleDashboardView | null {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
		const first = leaves[0];
		if (!first) return null;
		return first.view as OtoracleDashboardView;
	}

	runPipelineCmd(args: string[]): Promise<string> {
		return new Promise((resolve, reject) => {
			const { pythonPath, pipelineDir } = this.settings;
			const scriptPath = join(pipelineDir, 'scripts', 'pipeline.py');

			const proc = spawn(pythonPath, [scriptPath, ...args], {
				cwd: pipelineDir,
				env: { ...process.env },
			});

			let stdout = '';
			let stderr = '';

			proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
			proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

			proc.on('close', code => {
				if (code !== 0) {
					reject(new Error(stderr.trim() || `Process exited with code ${code}`));
				} else {
					resolve(stdout);
				}
			});

			proc.on('error', err => reject(err));
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<OtooracleSettings>);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
