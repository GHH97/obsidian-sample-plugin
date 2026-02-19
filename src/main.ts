import { App, ItemView, Modal, Notice, Plugin, WorkspaceLeaf } from 'obsidian';
import { spawn } from 'child_process';
import { mkdir, writeFile } from 'fs/promises';
import { join, basename, extname } from 'path';
import {
	DEFAULT_SETTINGS,
	OtooracleSettings,
	OtooracleSettingTab,
	SavedCollection,
	SourceType,
	SOURCE_TYPE_LABELS,
} from './settings';

export const VIEW_TYPE = 'otoracle-dashboard';


// ─── Pipeline types ────────────────────────────────────────────────────────────
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

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
	const d = new Date(iso);
	return (
		d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
		' ' +
		d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	);
}

function slugify(str: string): string {
	return str
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}

/** Strip .pdf extension and clean up the filename into a readable title. */
function titleFromFilename(filename: string): string {
	return basename(filename, extname(filename)).trim();
}

/**
 * Guess source type from filename.
 * Patterns like "Ch. 12", "Chapter 5", "Section" → textbook.
 * Everything else defaults to paper.
 */
function guessSourceType(filename: string): SourceType {
	if (/^ch(apter)?[\s._-]*\d+/i.test(filename)) return 'textbook';
	if (/\bchapter\b/i.test(filename))              return 'textbook';
	if (/\bsection\b/i.test(filename))              return 'textbook';
	return 'paper';
}

function buildCitationKey(collectionName: string, title: string): string {
	const bookWord = slugify(collectionName.split(/\s+/)[0] ?? collectionName);
	const titleSlug = slugify(title).slice(0, 60);
	return `${bookWord}-${titleSlug}`;
}

function escapeCSV(val: string): string {
	if (val.includes(',') || val.includes('"') || val.includes('\n')) {
		return '"' + val.replace(/"/g, '""') + '"';
	}
	return val;
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

		const addBtn = actions.createEl('button', { cls: 'otoracle-btn primary', text: '+ Add PDFs' });
		addBtn.addEventListener('click', () => new AddPDFsModal(this.app, this.plugin, this).open());

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
			const empty = body.createDiv('otoracle-empty');
			empty.createEl('p', { text: 'No pipeline runs yet.' });
			empty.createEl('p', { text: 'Click + Add PDFs to get started.' });
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

		const srcRow = box.createDiv('otoracle-row');
		srcRow.createEl('strong', { text: 'Sources:' });
		for (const [status, count] of Object.entries(summary.sources)) {
			srcRow.createEl('span', {
				text: `${status} ${count}`,
				cls: `otoracle-badge ${status}`,
			});
		}

		const statsRow = box.createDiv('otoracle-row');
		statsRow.createEl('span', { text: `Dead letters: ${summary.dead_letters}`, cls: 'otoracle-stat' });
		statsRow.createEl('span', { text: `Unresolved links: ${summary.unresolved_links}`, cls: 'otoracle-stat' });

		if (dead_letters.length > 0) {
			box.createEl('p', { text: 'Dead letters:', cls: 'otoracle-subsection' });
			const ul = box.createEl('ul', { cls: 'otoracle-dl-list' });
			for (const d of dead_letters) {
				ul.createEl('li', { text: `[${d.stage}] ${d.error}` });
			}
		}

		if (run.manifest_path) {
			const mpRow = box.createDiv('otoracle-row');
			mpRow.createEl('strong', { text: 'Manifest:' });
			mpRow.createEl('code', { text: run.manifest_path });
		}

		if (run.error) {
			box.createEl('p', { text: `Error: ${run.error}`, cls: 'otoracle-error' });
		}

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

		new Notice(dryRun ? 'Running dry-run…' : 'Starting ingest…');

		try {
			const raw = await this.plugin.runPipelineCmd(args);
			const result = JSON.parse(raw) as { summary?: { sources?: Record<string, number> } };
			const sources = result.summary?.sources ?? {};
			if (dryRun) {
				new Notice('Dry-run complete — no files published');
			} else {
				const published = sources['published'] ?? 0;
				const failed    = sources['failed']    ?? 0;
				new Notice(`Done — ${published} published, ${failed} failed`);
			}
			await this.render();
		} catch (e) {
			new Notice(`Ingest failed: ${e}`);
		}
	}
}

// ─── Add PDFs Modal ─────────────────────────────────────────────────────────────

interface FileEntry {
	file: File;
	title: string;
	sourceType: SourceType;
}

export class AddPDFsModal extends Modal {
	plugin: OtoraclePipelinePlugin;
	view: OtoracleDashboardView;

	private entries: FileEntry[] = [];

	// UI refs updated on re-render
	private fileListEl!: HTMLElement;
	private collectionInput!: HTMLInputElement;
	private yearInput!: HTMLInputElement;
	private authorsInput!: HTMLTextAreaElement;
	private processBtn!: HTMLButtonElement;
	private dryRunBtn!: HTMLButtonElement;

	constructor(app: App, plugin: OtoraclePipelinePlugin, view: OtoracleDashboardView) {
		super(app);
		this.plugin = plugin;
		this.view = view;
	}

	onOpen(): void {
		this.modalEl.addClass('otoracle-add-modal');
		const { contentEl } = this;

		contentEl.createEl('h3', { text: 'Add PDFs to pipeline' });

		// ── Drop zone ──────────────────────────────────────────────────────────
		const dropZone = contentEl.createDiv('otoracle-dropzone');
		dropZone.createEl('div', { cls: 'otoracle-dropzone-icon', text: '📄' });
		dropZone.createEl('p', { cls: 'otoracle-dropzone-label', text: 'Drop PDF files here' });
		const browseBtn = dropZone.createEl('button', { cls: 'otoracle-btn', text: 'Browse files' });

		// Hidden file input
		const fileInput = contentEl.createEl('input', {
			type: 'file',
			attr: { accept: '.pdf', multiple: 'true', style: 'display:none' },
		});

		browseBtn.addEventListener('click', () => fileInput.click());
		fileInput.addEventListener('change', () => {
			if (fileInput.files) this.addFiles(fileInput.files);
			fileInput.value = '';
		});

		dropZone.addEventListener('dragover', e => {
			e.preventDefault();
			dropZone.addClass('drag-over');
		});
		dropZone.addEventListener('dragleave', () => dropZone.removeClass('drag-over'));
		dropZone.addEventListener('drop', e => {
			e.preventDefault();
			dropZone.removeClass('drag-over');
			if (e.dataTransfer?.files) this.addFiles(e.dataTransfer.files);
		});

		// ── File list ──────────────────────────────────────────────────────────
		this.fileListEl = contentEl.createDiv('otoracle-file-cards');

		// ── Collection metadata ────────────────────────────────────────────────
		const meta = contentEl.createDiv('otoracle-meta-section');
		meta.createEl('p', { cls: 'otoracle-section-label', text: 'Collection' });

		// Collection name with datalist autocomplete from saved collections
		const collectionRow = meta.createDiv('otoracle-meta-row');
		const listId = 'otoracle-collections-list';
		this.collectionInput = collectionRow.createEl('input', {
			type: 'text',
			cls: 'otoracle-input',
			attr: { placeholder: 'e.g. Cummings Otolaryngology', list: listId },
		});
		const datalist = collectionRow.createEl('datalist', { attr: { id: listId } });
		for (const c of this.plugin.settings.savedCollections) {
			datalist.createEl('option', { attr: { value: c.name } });
		}

		// Auto-fill year + authors when a saved collection is chosen
		this.collectionInput.addEventListener('input', () => {
			const match = this.plugin.settings.savedCollections
				.find(c => c.name === this.collectionInput.value.trim());
			if (match) {
				this.yearInput.value    = match.year;
				this.authorsInput.value = match.authors;
				// Also apply default source type to any files without an override
				for (const entry of this.entries) {
					if (entry.sourceType !== match.defaultSourceType) {
						// only update if it was auto-guessed (not manually changed)
						// We don't track that distinction, so leave existing entries alone
					}
				}
			}
		});

		const yearAuthRow = meta.createDiv('otoracle-meta-row two-col');

		const yearWrap = yearAuthRow.createDiv();
		yearWrap.createEl('label', { cls: 'otoracle-field-label', text: 'Year / Edition' });
		this.yearInput = yearWrap.createEl('input', {
			type: 'text',
			cls: 'otoracle-input',
			attr: { placeholder: '2026' },
		});

		const authWrap = yearAuthRow.createDiv();
		authWrap.createEl('label', { cls: 'otoracle-field-label', text: 'Authors' });
		this.authorsInput = authWrap.createEl('textarea', {
			cls: 'otoracle-input otoracle-authors',
			attr: { placeholder: 'Howard W. Francis, Bruce H. Haughey…', rows: '2' },
		});

		// ── Footer ─────────────────────────────────────────────────────────────
		const footer = contentEl.createDiv('otoracle-modal-footer');
		this.dryRunBtn  = footer.createEl('button', { cls: 'otoracle-btn', text: 'Dry-run' });
		this.processBtn = footer.createEl('button', { cls: 'otoracle-btn primary', text: 'Process' });

		this.dryRunBtn.addEventListener('click',  () => this.submit(true));
		this.processBtn.addEventListener('click', () => this.submit(false));

		// Pre-fill from most recent collection
		const last = this.plugin.settings.savedCollections.at(-1);
		if (last) {
			this.collectionInput.value = last.name;
			this.yearInput.value       = last.year;
			this.authorsInput.value    = last.authors;
		}
	}

	private addFiles(files: FileList): void {
		for (let i = 0; i < files.length; i++) {
			const f = files[i] as File;
			if (!f.name.toLowerCase().endsWith('.pdf')) continue;
			if (this.entries.some(e => e.file.name === f.name && e.file.size === f.size)) continue; // dedupe
			this.entries.push({
				file: f,
				title: titleFromFilename(f.name),
				sourceType: guessSourceType(f.name),
			});
		}
		this.renderFileCards();
	}

	private renderFileCards(): void {
		this.fileListEl.empty();
		if (this.entries.length === 0) return;

		for (let i = 0; i < this.entries.length; i++) {
			const entry = this.entries[i]!;
			const card = this.fileListEl.createDiv('otoracle-file-card');

			// Title (editable)
			const titleRow = card.createDiv('otoracle-card-row');
			const titleInput = titleRow.createEl('input', {
				type: 'text',
				cls: 'otoracle-input',
				attr: { value: entry.title, placeholder: 'Chapter / article title' },
			});
			titleInput.addEventListener('input', () => { entry.title = titleInput.value; });

			// Source type + remove button
			const metaRow = card.createDiv('otoracle-card-row');
			const typeSelect = metaRow.createEl('select', { cls: 'otoracle-select' });
			for (const [val, label] of Object.entries(SOURCE_TYPE_LABELS) as [SourceType, string][]) {
				const opt = typeSelect.createEl('option', { value: val, text: label });
				if (val === entry.sourceType) opt.selected = true;
			}
			typeSelect.addEventListener('change', () => {
				entry.sourceType = typeSelect.value as SourceType;
			});

			const removeBtn = metaRow.createEl('button', { cls: 'otoracle-btn sm danger-ghost', text: '✕' });
			removeBtn.title = 'Remove';
			removeBtn.addEventListener('click', () => {
				this.entries.splice(i, 1);
				this.renderFileCards();
			});
		}
	}

	private validate(): string | null {
		if (this.entries.length === 0)               return 'Add at least one PDF.';
		if (!this.collectionInput.value.trim())      return 'Enter a collection name.';
		if (!this.yearInput.value.trim())            return 'Enter a year or edition.';
		for (const e of this.entries) {
			if (!e.title.trim()) return `A file is missing a title (${e.file.name}).`;
		}
		return null;
	}

	private async submit(dryRun: boolean): Promise<void> {
		const err = this.validate();
		if (err) { new Notice(err); return; }

		this.processBtn.disabled = true;
		this.dryRunBtn.disabled  = true;
		this.processBtn.textContent = 'Preparing…';

		try {
			const collectionName = this.collectionInput.value.trim();
			const year           = this.yearInput.value.trim();
			const authors        = this.authorsInput.value.trim();

			const { pipelineDir } = this.plugin.settings;
			const collectionSlug  = slugify(collectionName);
			const destDir         = join(pipelineDir, 'raw-pdfs', collectionSlug);

			// 1. Copy PDFs into raw-pdfs/<collection>/
			await mkdir(destDir, { recursive: true });
			const destPaths: string[] = [];
			for (const entry of this.entries) {
				const dest = join(destDir, entry.file.name);
				const buf = Buffer.from(await entry.file.arrayBuffer());
				await writeFile(dest, buf);
				destPaths.push(dest);
			}

			// 2. Build manifest CSV
			const header = 'source_path,source_type,book_or_collection,chapter_or_title,edition_or_year,authors,citation_key,region,priority,notes';
			const rows = this.entries.map((entry, idx) => {
				const citationKey = buildCitationKey(collectionName, entry.title);
				return [
					escapeCSV(destPaths[idx] ?? ''),
					escapeCSV(entry.sourceType),
					escapeCSV(collectionName),
					escapeCSV(entry.title),
					escapeCSV(year),
					escapeCSV(authors),
					escapeCSV(citationKey),
					'general',
					'normal',
					'',
				].join(',');
			});
			const csvContent = [header, ...rows].join('\n');

			// 3. Save manifest
			const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const manifestName = `${collectionSlug}-${ts}.manifest.csv`;
			const manifestPath = join(pipelineDir, 'data', 'manifests', manifestName);
			await mkdir(join(pipelineDir, 'data', 'manifests'), { recursive: true });
			await writeFile(manifestPath, csvContent, 'utf-8');

			// 4. Save collection for future use (upsert by name)
			const col: SavedCollection = {
				name: collectionName,
				year,
				authors,
				defaultSourceType: this.entries[0]?.sourceType ?? 'textbook',
			};
			const existing = this.plugin.settings.savedCollections;
			const idx = existing.findIndex(c => c.name === collectionName);
			if (idx >= 0) existing[idx] = col;
			else existing.push(col);
			await this.plugin.saveSettings();

			this.close();
			await this.view.runIngest(manifestPath, dryRun);
		} catch (e) {
			new Notice(`Failed to prepare ingest: ${e}`);
			this.processBtn.disabled = false;
			this.dryRunBtn.disabled  = false;
			this.processBtn.textContent = 'Process';
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
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
			id: 'add-pdfs',
			name: 'Add PDFs',
			callback: () => {
				const view = this.getDashboardView();
				if (view) new AddPDFsModal(this.app, this, view).open();
				else this.openDashboard().then(() => {
					const v = this.getDashboardView();
					if (v) new AddPDFsModal(this.app, this, v).open();
				});
			},
		});

		this.addCommand({
			id: 'reconcile-links',
			name: 'Reconcile all unresolved links',
			callback: async () => {
				const view = this.getDashboardView();
				if (view) await view.reconcileAll();
				else new Notice('Open the Otoracle dashboard first');
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
