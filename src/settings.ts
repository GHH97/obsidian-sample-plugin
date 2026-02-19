import { App, PluginSettingTab, Setting } from 'obsidian';
import OtoraclePipelinePlugin from './main';

export type SourceType = 'textbook' | 'paper' | 'presentation' | 'dataset';

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
	textbook:     'Textbook chapter',
	paper:        'Research article',
	presentation: 'Presentation / slides',
	dataset:      'Dataset',
};

export interface SavedCollection {
	name: string;
	year: string;
	authors: string;
	defaultSourceType: SourceType;
}

export interface OtooracleSettings {
	pipelineDir: string;
	pythonPath: string;
	autoRefreshSec: number;
	savedCollections: SavedCollection[];
}

export const DEFAULT_SETTINGS: OtooracleSettings = {
	pipelineDir: '/Users/gabolin/Documents/ent-pipeline',
	pythonPath: '/Users/gabolin/Documents/ent-pipeline/.venv/bin/python3',
	autoRefreshSec: 30,
	savedCollections: [],
};

export class OtooracleSettingTab extends PluginSettingTab {
	plugin: OtoraclePipelinePlugin;

	constructor(app: App, plugin: OtoraclePipelinePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: 'Otoracle Pipeline' });

		new Setting(containerEl)
			.setName('Pipeline directory')
			.setDesc('Absolute path to the ent-pipeline folder')
			.addText(text =>
				text
					.setPlaceholder('/Users/…/ent-pipeline')
					.setValue(this.plugin.settings.pipelineDir)
					.onChange(async value => {
						this.plugin.settings.pipelineDir = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Python executable')
			.setDesc('python3, python, or an absolute path')
			.addText(text =>
				text
					.setPlaceholder('python3')
					.setValue(this.plugin.settings.pythonPath)
					.onChange(async value => {
						this.plugin.settings.pythonPath = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Auto-refresh (seconds)')
			.setDesc('How often the dashboard polls for updates. Set 0 to disable.')
			.addText(text =>
				text
					.setPlaceholder('30')
					.setValue(String(this.plugin.settings.autoRefreshSec))
					.onChange(async value => {
						const n = parseInt(value, 10);
						if (!isNaN(n) && n >= 0) {
							this.plugin.settings.autoRefreshSec = n;
							await this.plugin.saveSettings();
						}
					})
			);
	}
}
