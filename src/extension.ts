import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

declare const fetch: (input: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
}) => Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly statusText: string;
    text(): Promise<string>;
}>;

type Seconds = number;

type CounterMap = Record<string, Seconds>;

type DashboardCommand = 'refresh' | 'exportJson' | 'openJson' | 'resetToday';

type DashboardMessage = DashboardReadyMessage | DashboardCommandMessage;

interface DashboardReadyMessage {
    readonly type: 'ready';
}

interface DashboardCommandMessage {
    readonly type: 'command';
    readonly command: DashboardCommand;
}

interface ActivityContext {
    readonly projectName: string;
    readonly languageId: string;
    readonly filePath: string;
}

interface DayStats {
    totalSeconds: Seconds;
    projects: CounterMap;
    languages: CounterMap;
    files: CounterMap;
}

interface NixieePulseStats {
    version: 1;
    createdAt: string;
    updatedAt: string;
    days: Record<string, DayStats>;
}

interface NixieePulseSettings {
    readonly idleTimeoutSeconds: Seconds;
    readonly tickIntervalSeconds: Seconds;
    readonly saveIntervalSeconds: Seconds;
    readonly trackFiles: boolean;
}

interface GitHubProfileSettings {
    readonly enabled: boolean;
    readonly owner: string;
    readonly repo: string;
    readonly branch: string;
    readonly readmePath: string;
    readonly mode: 'markdown' | 'svg' | 'both';
    readonly svgPath: string;
    readonly iconFolderPath: string;
    readonly autoSyncMinutes: number;
    readonly syncOnExit: boolean;
    readonly commitMessage: string;
    readonly maxLanguages: number;
    readonly hiddenLanguages: readonly string[];
}

interface GitHubContentFile {
    readonly path: string;
    readonly sha: string;
    readonly contentText: string;
}

interface AllTimeLanguageEntry {
    readonly language: string;
    readonly label: string;
    readonly seconds: Seconds;
    readonly duration: string;
    readonly percentage: number;
}

interface AllTimeSummary {
    readonly totalSeconds: Seconds;
    readonly totalDuration: string;
    readonly languages: AllTimeLanguageEntry[];
    readonly generatedAt: string;
    readonly generatedAtLocal: string;
}

interface CounterEntry {
    readonly name: string;
    readonly seconds: Seconds;
    readonly duration: string;
    readonly percentage: number;
}

interface DashboardDayEntry {
    readonly dateKey: string;
    readonly shortLabel: string;
    readonly seconds: Seconds;
    readonly duration: string;
    readonly percentage: number;
}

const GITHUB_TOKEN_SECRET_KEY = 'nixieepulse.github.token';
const NIXIEEPULSE_START_MARKER = '<!-- NIXIEEPULSE:START -->';
const NIXIEEPULSE_END_MARKER = '<!-- NIXIEEPULSE:END -->';

interface DashboardModel {
    readonly generatedAt: string;
    readonly todayDateKey: string;
    readonly todayTotalSeconds: Seconds;
    readonly todayTotalFormatted: string;
    readonly weekTotalSeconds: Seconds;
    readonly weekTotalFormatted: string;
    readonly topTodayProject: string;
    readonly topTodayLanguage: string;
    readonly topWeekProject: string;
    readonly topWeekLanguage: string;
    readonly todayLanguages: CounterEntry[];
    readonly weekLanguages: CounterEntry[];
    readonly weekProjects: CounterEntry[];
    readonly weekDailyTotals: DashboardDayEntry[];
    readonly statsPath: string;
}

class NixieePulseTracker implements vscode.Disposable {
    private readonly statsUri: vscode.Uri;
    private readonly statsBackupUri: vscode.Uri;
    private readonly statusBarItem: vscode.StatusBarItem;
    private readonly disposables: vscode.Disposable[] = [];

    private stats: NixieePulseStats = createEmptyStats();
    private currentContext: ActivityContext | null = null;
    private dashboardPanel: vscode.WebviewPanel | undefined;
    private isWindowFocused: boolean = vscode.window.state.focused;
    private lastActivityAt: number = Date.now();
    private lastTickAt: number = Date.now();
    private tickTimer: NodeJS.Timeout | undefined;
    private saveTimer: NodeJS.Timeout | undefined;
    private autoSyncTimer: NodeJS.Timeout | undefined;
    private isDirty: boolean = false;

    public constructor(private readonly extensionContext: vscode.ExtensionContext) {
        this.statsUri = vscode.Uri.joinPath(extensionContext.globalStorageUri, 'stats.json');
        this.statsBackupUri = vscode.Uri.joinPath(extensionContext.globalStorageUri, 'stats.backup.json');
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.statusBarItem.name = 'NixieePulse';
        this.statusBarItem.command = 'nixieepulse.openDashboard';
        this.statusBarItem.tooltip = 'NixieePulse: local coding time tracker';
        this.statusBarItem.show();
        this.disposables.push(this.statusBarItem);
    }

    public async activate(): Promise<void> {
        await this.loadStats();
        this.currentContext = this.getActivityContext(vscode.window.activeTextEditor);
        this.registerEvents();
        this.startTimers();
        this.updateStatusBar();
    }

    public async deactivate(): Promise<void> {
        const githubSettings: GitHubProfileSettings = this.getGitHubSettings();
        this.stopTimers();
        await this.saveStats(true);

        if (githubSettings.enabled && githubSettings.syncOnExit) {
            await this.syncGitHubProfile('VS Code shutdown', false);
        }
    }

    public dispose(): void {
        this.stopTimers();

        if (this.dashboardPanel !== undefined) {
            this.dashboardPanel.dispose();
            this.dashboardPanel = undefined;
        }

        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    private registerEvents(): void {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor: vscode.TextEditor | undefined): void => {
                this.currentContext = this.getActivityContext(editor);
                this.markActivity();
                this.updateStatusBar();
                void this.refreshDashboard();
            }),
            vscode.workspace.onDidChangeTextDocument((event: vscode.TextDocumentChangeEvent): void => {
                if (this.isTrackableDocument(event.document)) {
                    this.currentContext = this.getActivityContextFromDocument(event.document);
                    this.markActivity();
                }
            }),
            vscode.workspace.onDidSaveTextDocument((document: vscode.TextDocument): void => {
                if (this.isTrackableDocument(document)) {
                    this.currentContext = this.getActivityContextFromDocument(document);
                    this.markActivity();
                }
            }),
            vscode.window.onDidChangeWindowState((state: vscode.WindowState): void => {
                this.isWindowFocused = state.focused;

                if (state.focused) {
                    this.markActivity();
                } else {
                    this.lastTickAt = Date.now();
                }
            }),
            vscode.workspace.onDidChangeConfiguration((event: vscode.ConfigurationChangeEvent): void => {
                if (event.affectsConfiguration('nixieepulse')) {
                    this.restartTimers();
                }
            }),
            vscode.commands.registerCommand('nixieepulse.openDashboard', async (): Promise<void> => {
                await this.openDashboard();
            }),
            vscode.commands.registerCommand('nixieepulse.refreshDashboard', async (): Promise<void> => {
                await this.saveStats(true);
                await this.refreshDashboard();
                await this.postDashboardCommandResult('refresh', 'Dashboard refreshed.');
            }),
            vscode.commands.registerCommand('nixieepulse.showToday', async (): Promise<void> => {
                await this.showTodayStats();
            }),
            vscode.commands.registerCommand('nixieepulse.openStatsJson', async (): Promise<void> => {
                await this.openStatsJson();
            }),
            vscode.commands.registerCommand('nixieepulse.exportStatsJson', async (): Promise<void> => {
                await this.exportStatsJson();
            }),
            vscode.commands.registerCommand('nixieepulse.resetToday', async (): Promise<void> => {
                await this.resetTodayStats();
            }),
            vscode.commands.registerCommand('nixieepulse.syncGithubProfile', async (): Promise<void> => {
                await this.syncGitHubProfile('manual command', true);
            }),
            vscode.commands.registerCommand('nixieepulse.setGithubToken', async (): Promise<void> => {
                await this.setGitHubToken();
            }),
            vscode.commands.registerCommand('nixieepulse.clearGithubToken', async (): Promise<void> => {
                await this.clearGitHubToken();
            }),
            vscode.commands.registerCommand('nixieepulse.openGithubSetup', async (): Promise<void> => {
                await this.openGitHubSetupGuide();
            })
        );
    }

    private startTimers(): void {
        const settings: NixieePulseSettings = this.getSettings();
        const githubSettings: GitHubProfileSettings = this.getGitHubSettings();

        this.tickTimer = setInterval((): void => {
            void this.tick();
        }, settings.tickIntervalSeconds * 1000);

        this.saveTimer = setInterval((): void => {
            void this.saveStats();
        }, settings.saveIntervalSeconds * 1000);

        if (githubSettings.enabled && githubSettings.autoSyncMinutes > 0) {
            this.autoSyncTimer = setInterval((): void => {
                void this.syncGitHubProfile('automatic interval', false);
            }, githubSettings.autoSyncMinutes * 60 * 1000);
        }
    }

    private stopTimers(): void {
        if (this.tickTimer !== undefined) {
            clearInterval(this.tickTimer);
            this.tickTimer = undefined;
        }

        if (this.saveTimer !== undefined) {
            clearInterval(this.saveTimer);
            this.saveTimer = undefined;
        }

        if (this.autoSyncTimer !== undefined) {
            clearInterval(this.autoSyncTimer);
            this.autoSyncTimer = undefined;
        }
    }

    private restartTimers(): void {
        this.stopTimers();
        this.startTimers();
    }

    private async tick(): Promise<void> {
        const now: number = Date.now();
        const elapsedSeconds: Seconds = Math.floor((now - this.lastTickAt) / 1000);

        if (elapsedSeconds <= 0) {
            return;
        }

        this.lastTickAt = now;

        if (!this.shouldCountActivity(now)) {
            this.updateStatusBar();
            return;
        }

        const safeElapsedSeconds: Seconds = Math.min(elapsedSeconds, 60);
        this.addActiveSeconds(safeElapsedSeconds);
        this.updateStatusBar();

        if (this.dashboardPanel !== undefined && this.dashboardPanel.visible) {
            await this.refreshDashboard();
        }
    }

    private shouldCountActivity(now: number): boolean {
        if (!this.isWindowFocused) {
            return false;
        }

        if (this.currentContext === null) {
            return false;
        }

        const settings: NixieePulseSettings = this.getSettings();
        const idleSeconds: Seconds = Math.floor((now - this.lastActivityAt) / 1000);

        return idleSeconds <= settings.idleTimeoutSeconds;
    }

    private addActiveSeconds(seconds: Seconds): void {
        if (this.currentContext === null || seconds <= 0) {
            return;
        }

        const settings: NixieePulseSettings = this.getSettings();
        const dateKey: string = getLocalDateKey(new Date());
        const dayStats: DayStats = getOrCreateDayStats(this.stats, dateKey);

        dayStats.totalSeconds += seconds;
        incrementCounter(dayStats.projects, this.currentContext.projectName, seconds);
        incrementCounter(dayStats.languages, this.currentContext.languageId, seconds);

        if (settings.trackFiles) {
            incrementCounter(dayStats.files, this.currentContext.filePath, seconds);
        }

        this.stats.updatedAt = new Date().toISOString();
        this.isDirty = true;
    }

    private markActivity(): void {
        const now: number = Date.now();
        const settings: NixieePulseSettings = this.getSettings();
        const wasIdle: boolean = Math.floor((now - this.lastActivityAt) / 1000) > settings.idleTimeoutSeconds;

        this.lastActivityAt = now;

        if (wasIdle || !this.isWindowFocused) {
            this.lastTickAt = now;
        }
    }

    private getActivityContext(editor: vscode.TextEditor | undefined): ActivityContext | null {
        if (editor === undefined) {
            return null;
        }

        return this.getActivityContextFromDocument(editor.document);
    }

    private getActivityContextFromDocument(document: vscode.TextDocument): ActivityContext | null {
        if (!this.isTrackableDocument(document)) {
            return null;
        }

        const workspaceFolder: vscode.WorkspaceFolder | undefined = vscode.workspace.getWorkspaceFolder(document.uri);
        const projectName: string = workspaceFolder?.name ?? 'No Workspace';
        const languageId: string = document.languageId || 'unknown';
        const filePath: string = getSafeFilePath(document, workspaceFolder);

        return {
            projectName,
            languageId,
            filePath
        };
    }

    private isTrackableDocument(document: vscode.TextDocument): boolean {
        if (document.uri.scheme !== 'file') {
            return false;
        }

        if (document.isClosed) {
            return false;
        }

        return true;
    }

    private async loadStats(): Promise<void> {
        await vscode.workspace.fs.createDirectory(this.extensionContext.globalStorageUri);

        const primaryStats: NixieePulseStats | null = await this.readStatsFile(this.statsUri);

        if (primaryStats !== null) {
            this.stats = primaryStats;
            this.isDirty = false;
            return;
        }

        const backupStats: NixieePulseStats | null = await this.readStatsFile(this.statsBackupUri);

        if (backupStats !== null) {
            this.stats = backupStats;
            this.isDirty = true;
            await this.saveStats(true);
            return;
        }

        this.stats = createEmptyStats();
        this.isDirty = true;
        await this.saveStats(true);
    }

    private async readStatsFile(uri: vscode.Uri): Promise<NixieePulseStats | null> {
        try {
            const rawData: Uint8Array = await vscode.workspace.fs.readFile(uri);
            const text: string = Buffer.from(rawData).toString('utf8');
            const parsed: unknown = JSON.parse(text);

            return normalizeNixieePulseStats(parsed);
        } catch {
            return null;
        }
    }

    private async saveStats(force: boolean = false): Promise<void> {
        if (!force && !this.isDirty) {
            return;
        }

        await vscode.workspace.fs.createDirectory(this.extensionContext.globalStorageUri);

        const prettyJson: string = `${JSON.stringify(this.stats, null, 2)}\n`;
        const nextData: Uint8Array = Buffer.from(prettyJson, 'utf8');
        const tempUri: vscode.Uri = vscode.Uri.joinPath(this.extensionContext.globalStorageUri, 'stats.tmp.json');

        try {
            const previousData: Uint8Array = await vscode.workspace.fs.readFile(this.statsUri);
            await vscode.workspace.fs.writeFile(this.statsBackupUri, previousData);
        } catch {
            // No previous file yet, so there is nothing to back up.
        }

        await vscode.workspace.fs.writeFile(tempUri, nextData);

        try {
            await vscode.workspace.fs.rename(tempUri, this.statsUri, { overwrite: true });
        } catch {
            await vscode.workspace.fs.writeFile(this.statsUri, nextData);
        }

        this.isDirty = false;
    }

    private updateStatusBar(): void {
        const todayStats: DayStats = getOrCreateDayStats(this.stats, getLocalDateKey(new Date()));
        const contextLabel: string = this.currentContext === null
            ? 'No file'
            : `${this.currentContext.projectName} • ${this.currentContext.languageId}`;

        this.statusBarItem.text = `$(pulse) NixieePulse: ${formatDuration(todayStats.totalSeconds)}`;
        this.statusBarItem.tooltip = `Today: ${formatDuration(todayStats.totalSeconds)}\n${contextLabel}\nClick to open dashboard.`;
    }

    private async showTodayStats(): Promise<void> {
        const todayStats: DayStats = getOrCreateDayStats(this.stats, getLocalDateKey(new Date()));
        const topProject: string = formatTopCounter(todayStats.projects);
        const topLanguage: string = formatTopCounter(todayStats.languages);
        const message: string = [
            `Today: ${formatDuration(todayStats.totalSeconds)}`,
            `Top project: ${topProject}`,
            `Top language: ${topLanguage}`
        ].join(' | ');

        await vscode.window.showInformationMessage(message, 'Open Dashboard', 'Open JSON').then(async (choice: string | undefined): Promise<void> => {
            if (choice === 'Open Dashboard') {
                await this.openDashboard();
            }

            if (choice === 'Open JSON') {
                await this.openStatsJson();
            }
        });
    }

    private async openStatsJson(): Promise<void> {
        await this.saveStats(true);
        const document: vscode.TextDocument = await vscode.workspace.openTextDocument(this.statsUri);
        await vscode.window.showTextDocument(document, { preview: false });
    }

    private async exportStatsJson(): Promise<void> {
        await this.saveStats(true);

        const defaultFolderUri: vscode.Uri = vscode.workspace.workspaceFolders?.[0]?.uri ?? this.extensionContext.globalStorageUri;
        const defaultFileName: string = `nixieepulse-stats-${getLocalDateKey(new Date())}.json`;
        const defaultUri: vscode.Uri = vscode.Uri.joinPath(defaultFolderUri, defaultFileName);

        const targetUri: vscode.Uri | undefined = await vscode.window.showSaveDialog({
            defaultUri,
            filters: {
                JSON: ['json']
            },
            saveLabel: 'Export NixieePulse JSON'
        });

        if (targetUri === undefined) {
            return;
        }

        const prettyJson: string = `${JSON.stringify(this.stats, null, 2)}\n`;
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(prettyJson, 'utf8'));
        await vscode.window.showInformationMessage(`NixieePulse JSON exported to ${targetUri.fsPath}.`);
    }

    private async resetTodayStats(): Promise<void> {
        const answer: string | undefined = await vscode.window.showWarningMessage(
            'Reset NixieePulse stats for today?',
            { modal: true },
            'Reset'
        );

        if (answer !== 'Reset') {
            return;
        }

        const todayKey: string = getLocalDateKey(new Date());
        this.stats.days[todayKey] = createEmptyDayStats();
        this.stats.updatedAt = new Date().toISOString();
        this.isDirty = true;
        await this.saveStats(true);
        this.updateStatusBar();
        await this.refreshDashboard();
        await vscode.window.showInformationMessage('NixieePulse stats for today were reset.');
    }

    private async openDashboard(): Promise<void> {
        await this.saveStats(true);

        if (this.dashboardPanel !== undefined) {
            this.dashboardPanel.reveal(vscode.ViewColumn.One);
            await this.refreshDashboard();
            return;
        }

        const panel: vscode.WebviewPanel = vscode.window.createWebviewPanel(
            'nixieepulseDashboard',
            'NixieePulse Dashboard',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                enableCommandUris: true,
                retainContextWhenHidden: true
            }
        );

        this.dashboardPanel = panel;

        panel.webview.onDidReceiveMessage(async (message: unknown): Promise<void> => {
            if (!isDashboardMessage(message)) {
                return;
            }

            await this.handleDashboardMessage(message);
        }, undefined, this.disposables);

        panel.webview.html = this.getDashboardHtml(panel.webview);

        panel.onDidDispose((): void => {
            this.dashboardPanel = undefined;
        }, undefined, this.disposables);
    }

    private async handleDashboardMessage(message: DashboardMessage): Promise<void> {
        if (message.type === 'ready') {
            await this.refreshDashboard();
            return;
        }

        if (message.type !== 'command') {
            return;
        }

        if (message.command === 'refresh') {
            await this.saveStats(true);
            await this.refreshDashboard();
            await this.postDashboardCommandResult(message.command, 'Dashboard refreshed.');
            return;
        }

        if (message.command === 'exportJson') {
            await this.exportStatsJson();
            await this.postDashboardCommandResult(message.command, 'JSON export finished or cancelled.');
            return;
        }

        if (message.command === 'openJson') {
            await this.openStatsJson();
            await this.postDashboardCommandResult(message.command, 'Stats JSON opened.');
            return;
        }

        if (message.command === 'resetToday') {
            await this.resetTodayStats();
            await this.postDashboardCommandResult(message.command, 'Today was reset.');
        }
    }

    private async postDashboardCommandResult(command: DashboardCommand, message: string): Promise<void> {
        if (this.dashboardPanel === undefined) {
            return;
        }

        await this.dashboardPanel.webview.postMessage({
            type: 'commandResult',
            command,
            message,
            generatedAt: new Date().toISOString()
        });
    }

    private async refreshDashboard(): Promise<void> {
        if (this.dashboardPanel === undefined) {
            return;
        }

        await this.dashboardPanel.webview.postMessage({
            type: 'dashboardData',
            data: this.createDashboardModel()
        });
    }

    private getDashboardHtml(webview: vscode.Webview): string {
        const nonce: string = createNonce();
        const modelJson: string = serializeForScript(this.createDashboardModel());
        const cspSource: string = webview.cspSource;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NixieePulse Dashboard</title>
    <style>
        :root {
            color-scheme: light dark;
            --bg: var(--vscode-editor-background);
            --fg: var(--vscode-editor-foreground);
            --muted: var(--vscode-descriptionForeground);
            --card: var(--vscode-sideBar-background);
            --border: var(--vscode-panel-border);
            --accent: var(--vscode-button-background);
            --accent-fg: var(--vscode-button-foreground);
            --danger: var(--vscode-errorForeground);
        }

        * {
            box-sizing: border-box;
        }

        body {
            margin: 0;
            padding: 24px;
            background: var(--bg);
            color: var(--fg);
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
        }

        .page {
            max-width: 1120px;
            margin: 0 auto;
        }

        .hero {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 20px;
            margin-bottom: 20px;
        }

        h1 {
            margin: 0 0 8px;
            font-size: 32px;
            line-height: 1.1;
        }

        .subtitle {
            margin: 0;
            color: var(--muted);
        }

        .actions {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            justify-content: flex-end;
        }

        .button-link {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border: 1px solid transparent;
            border-radius: 8px;
            padding: 8px 12px;
            background: var(--accent);
            color: var(--accent-fg);
            cursor: pointer;
            font: inherit;
            text-decoration: none;
            user-select: none;
        }

        .button-link.secondary {
            background: transparent;
            color: var(--fg);
            border-color: var(--border);
        }

        .button-link.danger {
            background: transparent;
            color: var(--danger);
            border-color: var(--danger);
        }

        .button-link:hover {
            filter: brightness(1.08);
            text-decoration: none;
        }

        .grid {
            display: grid;
            grid-template-columns: repeat(12, 1fr);
            gap: 16px;
        }

        .card {
            grid-column: span 6;
            border: 1px solid var(--border);
            border-radius: 16px;
            background: var(--card);
            padding: 18px;
            min-height: 120px;
            box-shadow: 0 10px 30px rgba(0, 0, 0, 0.12);
        }

        .card.small {
            grid-column: span 3;
        }

        .card.full {
            grid-column: span 12;
        }

        .card h2 {
            margin: 0 0 14px;
            font-size: 16px;
            color: var(--muted);
            font-weight: 600;
        }

        .big-number {
            font-size: 34px;
            line-height: 1.1;
            font-weight: 800;
            margin-bottom: 8px;
        }

        .meta {
            color: var(--muted);
            line-height: 1.6;
        }

        .bars {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .bar-row {
            display: grid;
            grid-template-columns: minmax(120px, 180px) 1fr minmax(70px, auto);
            align-items: center;
            gap: 12px;
        }

        .bar-label {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .bar-track {
            height: 10px;
            border-radius: 999px;
            background: color-mix(in srgb, var(--fg) 12%, transparent);
            overflow: hidden;
        }

        .bar-fill {
            height: 100%;
            width: 0;
            border-radius: 999px;
            background: var(--accent);
            transition: width 250ms ease;
        }

        .bar-time {
            color: var(--muted);
            text-align: right;
            white-space: nowrap;
        }

        .daily-chart {
            display: grid;
            grid-template-columns: repeat(7, 1fr);
            align-items: end;
            gap: 12px;
            min-height: 220px;
            padding-top: 12px;
        }

        .day-column {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 8px;
            min-width: 0;
        }

        .day-bar-wrap {
            display: flex;
            align-items: end;
            height: 150px;
            width: 100%;
            border-radius: 12px;
            background: color-mix(in srgb, var(--fg) 8%, transparent);
            overflow: hidden;
        }

        .day-bar {
            width: 100%;
            min-height: 2px;
            background: var(--accent);
            border-radius: 12px 12px 0 0;
            transition: height 250ms ease;
        }

        .day-label,
        .day-time {
            color: var(--muted);
            font-size: 12px;
            text-align: center;
            white-space: nowrap;
        }

        .empty {
            color: var(--muted);
            border: 1px dashed var(--border);
            border-radius: 12px;
            padding: 18px;
            text-align: center;
        }

        code {
            color: var(--muted);
            word-break: break-all;
        }

        .status-line {
            margin-top: 10px;
            color: var(--muted);
            min-height: 18px;
            font-size: 12px;
        }

        @media (max-width: 900px) {
            .hero {
                flex-direction: column;
            }

            .actions {
                justify-content: flex-start;
            }

            .card,
            .card.small {
                grid-column: span 12;
            }

            .bar-row {
                grid-template-columns: 1fr;
                gap: 6px;
            }

            .bar-time {
                text-align: left;
            }
        }
    </style>
</head>
<body>
    <main class="page">
        <section class="hero">
            <div>
                <h1>NixieePulse Dashboard</h1>
                <p class="subtitle">Local coding stats from your JSON storage. GitHub sync is optional.</p>
            </div>
            <div>
                <div class="actions">
                    <a role="button" class="button-link" href="command:nixieepulse.refreshDashboard">Refresh</a>
                    <a role="button" class="button-link secondary" href="command:nixieepulse.syncGithubProfile">Sync GitHub</a>
                    <a role="button" class="button-link secondary" href="command:nixieepulse.setGithubToken">Set Token</a>
                    <a role="button" class="button-link secondary" href="command:nixieepulse.exportStatsJson">Export JSON</a>
                    <a role="button" class="button-link secondary" href="command:nixieepulse.openStatsJson">Open JSON</a>
                    <a role="button" class="button-link danger" href="command:nixieepulse.resetToday">Reset Today</a>
                </div>
                <div id="dashboardStatus" class="status-line" aria-live="polite"></div>
            </div>
        </section>

        <section class="grid">
            <article class="card small">
                <h2>Today</h2>
                <div id="todayTotal" class="big-number">0s</div>
                <div id="todayMeta" class="meta"></div>
            </article>

            <article class="card small">
                <h2>Last 7 days</h2>
                <div id="weekTotal" class="big-number">0s</div>
                <div id="weekMeta" class="meta"></div>
            </article>

            <article class="card small">
                <h2>Top project</h2>
                <div id="topProject" class="big-number">—</div>
                <div class="meta">For the last 7 days</div>
            </article>

            <article class="card small">
                <h2>Top language</h2>
                <div id="topLanguage" class="big-number">—</div>
                <div class="meta">For the last 7 days</div>
            </article>

            <article class="card full">
                <h2>Daily activity — last 7 days</h2>
                <div id="dailyChart" class="daily-chart"></div>
            </article>

            <article class="card">
                <h2>Languages today</h2>
                <div id="todayLanguages" class="bars"></div>
            </article>

            <article class="card">
                <h2>Languages — last 7 days</h2>
                <div id="weekLanguages" class="bars"></div>
            </article>

            <article class="card full">
                <h2>Projects — last 7 days</h2>
                <div id="weekProjects" class="bars"></div>
            </article>

            <article class="card full">
                <h2>Storage</h2>
                <div class="meta">Stats file: <code id="statsPath"></code></div>
                <div class="meta">Last dashboard update: <span id="generatedAt"></span></div>
            </article>
        </section>
    </main>

    <script nonce="${nonce}">
        const vscodeApi = acquireVsCodeApi();
        let dashboardData = ${modelJson};

        window.addEventListener('message', (event) => {
            const message = event.data;

            if (!message || typeof message.type !== 'string') {
                return;
            }

            if (message.type === 'dashboardData') {
                dashboardData = message.data;
                render(dashboardData);
                setStatus('Dashboard updated.');
                return;
            }

            if (message.type === 'commandResult') {
                setStatus(message.message || 'Command completed.');
            }
        });

        function render(data) {
            setText('todayTotal', data.todayTotalFormatted);
            setText('weekTotal', data.weekTotalFormatted);
            setText('todayMeta', 'Top project: ' + data.topTodayProject + '\\nTop language: ' + data.topTodayLanguage);
            setText('weekMeta', 'Top project: ' + data.topWeekProject + '\\nTop language: ' + data.topWeekLanguage);
            setText('topProject', stripDuration(data.topWeekProject));
            setText('topLanguage', stripDuration(data.topWeekLanguage));
            setText('statsPath', data.statsPath);
            setText('generatedAt', new Date(data.generatedAt).toLocaleString());

            renderDailyChart('dailyChart', data.weekDailyTotals);
            renderBars('todayLanguages', data.todayLanguages);
            renderBars('weekLanguages', data.weekLanguages);
            renderBars('weekProjects', data.weekProjects);
        }

        function renderBars(containerId, entries) {
            const container = document.getElementById(containerId);
            container.textContent = '';

            if (!entries || entries.length === 0) {
                container.appendChild(createEmptyBlock('No data yet. Start editing a file to collect activity.'));
                return;
            }

            for (const entry of entries.slice(0, 10)) {
                const row = document.createElement('div');
                row.className = 'bar-row';

                const label = document.createElement('div');
                label.className = 'bar-label';
                label.title = entry.name;
                label.textContent = entry.name;

                const track = document.createElement('div');
                track.className = 'bar-track';

                const fill = document.createElement('div');
                fill.className = 'bar-fill';
                fill.style.width = Math.max(entry.percentage, 2) + '%';
                track.appendChild(fill);

                const time = document.createElement('div');
                time.className = 'bar-time';
                time.textContent = entry.duration;

                row.append(label, track, time);
                container.appendChild(row);
            }
        }

        function renderDailyChart(containerId, entries) {
            const container = document.getElementById(containerId);
            container.textContent = '';

            for (const entry of entries) {
                const column = document.createElement('div');
                column.className = 'day-column';

                const time = document.createElement('div');
                time.className = 'day-time';
                time.textContent = entry.duration;

                const wrap = document.createElement('div');
                wrap.className = 'day-bar-wrap';

                const bar = document.createElement('div');
                bar.className = 'day-bar';
                bar.style.height = Math.max(entry.percentage, entry.seconds > 0 ? 4 : 0) + '%';
                wrap.appendChild(bar);

                const label = document.createElement('div');
                label.className = 'day-label';
                label.textContent = entry.shortLabel;

                column.append(time, wrap, label);
                container.appendChild(column);
            }
        }

        function createEmptyBlock(text) {
            const block = document.createElement('div');
            block.className = 'empty';
            block.textContent = text;
            return block;
        }

        function stripDuration(value) {
            if (value === 'none') {
                return '—';
            }

            return value.replace(/\s*\([^)]*\)$/, '');
        }

        function setText(id, value) {
            const element = document.getElementById(id);

            if (!element) {
                return;
            }

            element.textContent = value;
        }

        function setStatus(value) {
            setText('dashboardStatus', value);
        }

        render(dashboardData);
        vscodeApi.postMessage({ type: 'ready' });
    </script>
</body>
</html>`;
    }

    private createDashboardModel(): DashboardModel {
        const todayDateKey: string = getLocalDateKey(new Date());
        const weekDateKeys: string[] = getLastLocalDateKeys(7);
        const todayStats: DayStats = getDayStatsOrEmpty(this.stats, todayDateKey);
        const weekStats: DayStats = aggregateDays(this.stats, weekDateKeys);

        const maxDailySeconds: Seconds = Math.max(
            ...weekDateKeys.map((dateKey: string): Seconds => getDayStatsOrEmpty(this.stats, dateKey).totalSeconds),
            1
        );

        return {
            generatedAt: new Date().toISOString(),
            todayDateKey,
            todayTotalSeconds: todayStats.totalSeconds,
            todayTotalFormatted: formatDuration(todayStats.totalSeconds),
            weekTotalSeconds: weekStats.totalSeconds,
            weekTotalFormatted: formatDuration(weekStats.totalSeconds),
            topTodayProject: formatTopCounter(todayStats.projects),
            topTodayLanguage: formatTopCounter(todayStats.languages),
            topWeekProject: formatTopCounter(weekStats.projects),
            topWeekLanguage: formatTopCounter(weekStats.languages),
            todayLanguages: counterToEntries(todayStats.languages, todayStats.totalSeconds),
            weekLanguages: counterToEntries(weekStats.languages, weekStats.totalSeconds),
            weekProjects: counterToEntries(weekStats.projects, weekStats.totalSeconds),
            weekDailyTotals: weekDateKeys.map((dateKey: string): DashboardDayEntry => {
                const dayStats: DayStats = getDayStatsOrEmpty(this.stats, dateKey);

                return {
                    dateKey,
                    shortLabel: formatShortDateLabel(dateKey),
                    seconds: dayStats.totalSeconds,
                    duration: formatDuration(dayStats.totalSeconds),
                    percentage: roundPercentage(dayStats.totalSeconds, maxDailySeconds)
                };
            }),
            statsPath: this.statsUri.fsPath
        };
    }

    private async setGitHubToken(): Promise<void> {
        const token: string | undefined = await vscode.window.showInputBox({
            title: 'NixieePulse GitHub Token',
            prompt: 'Paste a fine-grained GitHub token with Contents: Read and write access to your profile README repository.',
            password: true,
            ignoreFocusOut: true,
            placeHolder: 'github_pat_...'
        });

        if (token === undefined || token.trim().length === 0) {
            return;
        }

        await this.extensionContext.secrets.store(GITHUB_TOKEN_SECRET_KEY, token.trim());
        await vscode.window.showInformationMessage('NixieePulse GitHub token saved in VS Code SecretStorage.');
    }

    private async clearGitHubToken(): Promise<void> {
        const answer: string | undefined = await vscode.window.showWarningMessage(
            'Clear the saved NixieePulse GitHub token from VS Code SecretStorage?',
            { modal: true },
            'Clear Token'
        );

        if (answer !== 'Clear Token') {
            return;
        }

        await this.extensionContext.secrets.delete(GITHUB_TOKEN_SECRET_KEY);
        await vscode.window.showInformationMessage('NixieePulse GitHub token cleared.');
    }

    private async openGitHubSetupGuide(): Promise<void> {
        const settings: GitHubProfileSettings = this.getGitHubSettings();
        const content: string = createGitHubSetupGuide(settings);
        const document: vscode.TextDocument = await vscode.workspace.openTextDocument({
            language: 'markdown',
            content
        });

        await vscode.window.showTextDocument(document, { preview: false });
    }

    private async syncGitHubProfile(reason: string, showMessages: boolean): Promise<void> {
        const settings: GitHubProfileSettings = this.getGitHubSettings();

        if (!settings.enabled) {
            if (showMessages) {
                const choice: string | undefined = await vscode.window.showInformationMessage(
                    'NixieePulse GitHub sync is disabled. Enable nixieepulse.githubProfile.enabled in settings first.',
                    'Open Setup Guide'
                );

                if (choice === 'Open Setup Guide') {
                    await this.openGitHubSetupGuide();
                }
            }

            return;
        }

        const validationError: string | null = validateGitHubSettings(settings);

        if (validationError !== null) {
            if (showMessages) {
                const choice: string | undefined = await vscode.window.showErrorMessage(validationError, 'Open Setup Guide');

                if (choice === 'Open Setup Guide') {
                    await this.openGitHubSetupGuide();
                }
            }

            return;
        }

        const token: string | undefined = await this.extensionContext.secrets.get(GITHUB_TOKEN_SECRET_KEY);

        if (token === undefined || token.trim().length === 0) {
            if (showMessages) {
                const choice: string | undefined = await vscode.window.showWarningMessage(
                    'NixieePulse GitHub token is not set.',
                    'Set Token',
                    'Open Setup Guide'
                );

                if (choice === 'Set Token') {
                    await this.setGitHubToken();
                }

                if (choice === 'Open Setup Guide') {
                    await this.openGitHubSetupGuide();
                }
            }

            return;
        }

        try {
            await this.saveStats(true);

            const summary: AllTimeSummary = createAllTimeSummary(this.stats, settings.maxLanguages, settings.hiddenLanguages);
            const updates: string[] = [];

            if (settings.mode === 'svg' || settings.mode === 'both') {
                const svgContent: string = generateNixieePulseSvg(summary, settings.iconFolderPath);
                const svgUpdateResult: boolean = await updateGitHubFileIfChanged(
                    settings,
                    token,
                    settings.svgPath,
                    svgContent,
                    `${settings.commitMessage} [svg]`
                );

                if (svgUpdateResult) {
                    updates.push(settings.svgPath);
                }
            }

            const readmeContentFile: GitHubContentFile | null = await getGitHubContentFile(settings, token, settings.readmePath);
            const currentReadme: string = readmeContentFile?.contentText ?? createDefaultReadme(settings);
            const generatedBlock: string = generateGitHubReadmeBlock(summary, settings);
            const nextReadme: string = replaceNixieePulseReadmeBlock(currentReadme, generatedBlock);

            if (nextReadme !== currentReadme) {
                await putGitHubContentFile(settings, token, {
                    path: settings.readmePath,
                    contentText: nextReadme,
                    sha: readmeContentFile?.sha,
                    message: `${settings.commitMessage} [readme]`
                });
                updates.push(settings.readmePath);
            }

            if (showMessages) {
                if (updates.length === 0) {
                    await vscode.window.showInformationMessage('NixieePulse GitHub profile is already up to date.');
                } else {
                    await vscode.window.showInformationMessage(`NixieePulse GitHub sync completed: ${updates.join(', ')}.`);
                }
            }

            await this.postDashboardCommandResult('refresh', `GitHub sync completed (${reason}).`);
        } catch (error: unknown) {
            const message: string = error instanceof Error ? error.message : String(error);

            if (showMessages) {
                await vscode.window.showErrorMessage(`NixieePulse GitHub sync failed: ${message}`);
            }

            await this.postDashboardCommandResult('refresh', `GitHub sync failed: ${message}`);
        }
    }

    private getSettings(): NixieePulseSettings {
        const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('nixieepulse');

        return {
            idleTimeoutSeconds: config.get<number>('idleTimeoutSeconds', 120),
            tickIntervalSeconds: config.get<number>('tickIntervalSeconds', 1),
            saveIntervalSeconds: config.get<number>('saveIntervalSeconds', 30),
            trackFiles: config.get<boolean>('trackFiles', false)
        };
    }


    private getGitHubSettings(): GitHubProfileSettings {
        const config: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration('nixieepulse.githubProfile');
        const mode: string = config.get<string>('mode', 'svg');

        return {
            enabled: config.get<boolean>('enabled', false),
            owner: config.get<string>('owner', '').trim(),
            repo: config.get<string>('repo', '').trim(),
            branch: config.get<string>('branch', 'main').trim() || 'main',
            readmePath: normalizeRepoPath(config.get<string>('readmePath', 'README.md')),
            mode: isGitHubMode(mode) ? mode : 'svg',
            svgPath: normalizeRepoPath(config.get<string>('svgPath', 'assets/coding-activity.svg')),
            iconFolderPath: config.get<string>('iconFolderPath', '').trim(),
            autoSyncMinutes: config.get<number>('autoSyncMinutes', 30),
            syncOnExit: config.get<boolean>('syncOnExit', true),
            commitMessage:
                config.get<string>('commitMessage', 'Update coding activity stats').trim() ||
                'Update coding activity stats',
            maxLanguages: clampInteger(config.get<number>('maxLanguages', 6), 1, 20),
            hiddenLanguages: normalizeLanguageFilter(config.get<unknown[]>('hiddenLanguages', [...DEFAULT_HIDDEN_GITHUB_LANGUAGES]))
        };
    }
}

let tracker: NixieePulseTracker | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    tracker = new NixieePulseTracker(context);
    context.subscriptions.push(tracker);
    await tracker.activate();
}

export async function deactivate(): Promise<void> {
    if (tracker !== undefined) {
        await tracker.deactivate();
        tracker.dispose();
        tracker = undefined;
    }
}

function createEmptyStats(): NixieePulseStats {
    const now: string = new Date().toISOString();

    return {
        version: 1,
        createdAt: now,
        updatedAt: now,
        days: {}
    };
}

function createEmptyDayStats(): DayStats {
    return {
        totalSeconds: 0,
        projects: {},
        languages: {},
        files: {}
    };
}

function getOrCreateDayStats(stats: NixieePulseStats, dateKey: string): DayStats {
    const existingDayStats: DayStats | undefined = stats.days[dateKey];

    if (existingDayStats !== undefined) {
        return existingDayStats;
    }

    const dayStats: DayStats = createEmptyDayStats();
    stats.days[dateKey] = dayStats;
    return dayStats;
}

function getDayStatsOrEmpty(stats: NixieePulseStats, dateKey: string): DayStats {
    return stats.days[dateKey] ?? createEmptyDayStats();
}

function aggregateDays(stats: NixieePulseStats, dateKeys: string[]): DayStats {
    const result: DayStats = createEmptyDayStats();

    for (const dateKey of dateKeys) {
        const dayStats: DayStats = getDayStatsOrEmpty(stats, dateKey);
        result.totalSeconds += dayStats.totalSeconds;
        mergeCounters(result.projects, dayStats.projects);
        mergeCounters(result.languages, dayStats.languages);
        mergeCounters(result.files, dayStats.files);
    }

    return result;
}

function mergeCounters(target: CounterMap, source: CounterMap): void {
    for (const [key, seconds] of Object.entries(source)) {
        incrementCounter(target, key, seconds);
    }
}

function incrementCounter(counter: CounterMap, key: string, seconds: Seconds): void {
    counter[key] = (counter[key] ?? 0) + seconds;
}

function getLocalDateKey(date: Date): string {
    const year: number = date.getFullYear();
    const month: string = String(date.getMonth() + 1).padStart(2, '0');
    const day: string = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

function getLastLocalDateKeys(daysCount: number): string[] {
    const today: Date = new Date();
    const dateKeys: string[] = [];

    for (let offset: number = daysCount - 1; offset >= 0; offset -= 1) {
        const date: Date = new Date(today);
        date.setDate(today.getDate() - offset);
        dateKeys.push(getLocalDateKey(date));
    }

    return dateKeys;
}

function formatShortDateLabel(dateKey: string): string {
    const parts: string[] = dateKey.split('-');

    if (parts.length !== 3) {
        return dateKey;
    }

    return `${parts[2]}.${parts[1]}`;
}

function getSafeFilePath(document: vscode.TextDocument, workspaceFolder: vscode.WorkspaceFolder | undefined): string {
    if (workspaceFolder === undefined) {
        return path.basename(document.uri.fsPath);
    }

    const relativePath: string = path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath);
    return relativePath.split(path.sep).join('/');
}

function formatDuration(totalSeconds: Seconds): string {
    const hours: number = Math.floor(totalSeconds / 3600);
    const minutes: number = Math.floor((totalSeconds % 3600) / 60);
    const seconds: number = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    if (minutes > 0) {
        return `${minutes}m ${seconds}s`;
    }

    return `${seconds}s`;
}

function formatTopCounter(counter: CounterMap): string {
    const entries: Array<[string, Seconds]> = Object.entries(counter);

    if (entries.length === 0) {
        return 'none';
    }

    const [name, seconds]: [string, Seconds] = entries.sort((a: [string, Seconds], b: [string, Seconds]): number => b[1] - a[1])[0];
    return `${name} (${formatDuration(seconds)})`;
}

function counterToEntries(counter: CounterMap, totalSeconds: Seconds): CounterEntry[] {
    return Object.entries(counter)
        .sort((a: [string, Seconds], b: [string, Seconds]): number => b[1] - a[1])
        .map(([name, seconds]: [string, Seconds]): CounterEntry => ({
            name,
            seconds,
            duration: formatDuration(seconds),
            percentage: roundPercentage(seconds, totalSeconds)
        }));
}

function roundPercentage(value: Seconds, total: Seconds): number {
    if (total <= 0) {
        return 0;
    }

    return Math.round((value / total) * 1000) / 10;
}

function createNonce(): string {
    return crypto.randomBytes(16).toString('hex');
}

function serializeForScript(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003C')
        .replace(/>/g, '\\u003E')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}


const DEFAULT_HIDDEN_GITHUB_LANGUAGES: readonly string[] = [
    'ignore',
    'gitignore',
    'pip-requirements',
    'requirements',
    'plaintext',
    'text',
    'log',
    'dotenv',
    'env',
    'properties',
    'ini',
    'toml',
    'git-commit',
    'git-rebase',
    'csv',
    'tsv'
];

function normalizeLanguageFilter(value: readonly unknown[]): readonly string[] {
    return Array.from(
        new Set(
            value
                .filter((item: unknown): item is string => typeof item === 'string')
                .map((item: string): string => normalizeLanguageId(item))
                .filter((item: string): boolean => item.length > 0)
        )
    );
}

function normalizeLanguageId(language: string): string {
    return language.trim().toLowerCase();
}

function createAllTimeSummary(
    stats: NixieePulseStats,
    maxLanguages: number,
    hiddenLanguages: readonly string[]
): AllTimeSummary {
    const aggregate: DayStats = aggregateDays(stats, Object.keys(stats.days));
    const hiddenLanguageSet: Set<string> = new Set(hiddenLanguages.map((language: string): string => normalizeLanguageId(language)));
    const visibleLanguageEntries: [string, Seconds][] = Object.entries(aggregate.languages)
        .filter(([language, seconds]: [string, Seconds]): boolean => {
            return seconds > 0 && !hiddenLanguageSet.has(normalizeLanguageId(language));
        })
        .sort((a: [string, Seconds], b: [string, Seconds]): number => b[1] - a[1]);
    const visibleTotalSeconds: Seconds = visibleLanguageEntries.reduce(
        (total: Seconds, [, seconds]: [string, Seconds]): Seconds => total + seconds,
        0
    );
    const languages: AllTimeLanguageEntry[] = visibleLanguageEntries
        .slice(0, maxLanguages)
        .map(([language, seconds]: [string, Seconds]): AllTimeLanguageEntry => ({
            language,
            label: formatLanguageLabel(language),
            seconds,
            duration: formatDuration(seconds),
            percentage: roundPercentage(seconds, visibleTotalSeconds)
        }));

    const updatedAt: Date = new Date(stats.updatedAt);

    return {
        totalSeconds: visibleTotalSeconds,
        totalDuration: formatDuration(visibleTotalSeconds),
        languages,
        generatedAt: updatedAt.toISOString(),
        generatedAtLocal: updatedAt.toLocaleString()
    };
}

function generateGitHubReadmeBlock(summary: AllTimeSummary, settings: GitHubProfileSettings): string {
    const markdownTable: string = generateCodingActivityMarkdownTable(summary);

    if (settings.mode === 'markdown') {
        return markdownTable;
    }

    const svgMarkdown: string = [
        '<p align="center">',
        `  <img src="./${settings.svgPath}" alt="Coding Activity" width="1080" />`,
        '</p>'
    ].join('\n');

    if (settings.mode === 'svg') {
        return svgMarkdown;
    }

    return [
        svgMarkdown,
        '',
        '<details>',
        '<summary>Show detailed language table</summary>',
        '',
        markdownTable,
        '',
        '</details>'
    ].join('\n');
}

function generateCodingActivityMarkdownTable(summary: AllTimeSummary): string {
    const lines: string[] = [
        `**Total tracked:** ${summary.totalDuration}`,
        '',
        '| Language | Time | Share |',
        '|---|---:|---:|'
    ];

    if (summary.languages.length === 0) {
        lines.push('| No data yet | 0s | 0% |');
    } else {
        for (const entry of summary.languages) {
            lines.push(`| ${escapeMarkdownCell(entry.label)} | ${entry.duration} | ${entry.percentage}% |`);
        }
    }

    lines.push('', `Last update: ${summary.generatedAtLocal}`);
    return lines.join('\n');
}

function replaceNixieePulseReadmeBlock(readme: string, generatedBlock: string): string {
    const replacement: string = [NIXIEEPULSE_START_MARKER, generatedBlock.trim(), NIXIEEPULSE_END_MARKER].join('\n');
    const startIndex: number = readme.indexOf(NIXIEEPULSE_START_MARKER);
    const endIndex: number = readme.indexOf(NIXIEEPULSE_END_MARKER);

    if (startIndex >= 0 && endIndex > startIndex) {
        const before: string = readme.slice(0, startIndex).trimEnd();
        const after: string = readme.slice(endIndex + NIXIEEPULSE_END_MARKER.length).trimStart();
        return `${before}\n\n${replacement}\n\n${after}`.trimEnd() + '\n';
    }

    return `${readme.trimEnd()}\n\n## Coding Activity\n\n${replacement}\n`;
}

function createDefaultReadme(settings: GitHubProfileSettings): string {
    return `# ${settings.owner}\n\n## Coding Activity\n\n${NIXIEEPULSE_START_MARKER}\n${NIXIEEPULSE_END_MARKER}\n`;
}

function generateNixieePulseSvg(summary: AllTimeSummary, iconFolderPath: string): string {
    const width: number = 1080;
    const paddingX: number = 40;
    const headerHeight: number = 104;
    const rowHeight: number = 48;
    const footerHeight: number = 72;
    const languageRows: AllTimeLanguageEntry[] = summary.languages.length > 0
        ? summary.languages
        : [{ language: 'none', label: 'No data yet', seconds: 0, duration: '0s', percentage: 0 }];
    const height: number = headerHeight + languageRows.length * rowHeight + footerHeight;
    const iconX: number = paddingX;
    const labelX: number = paddingX + 38;
    const barX: number = 332;
    const barWidth: number = 400;
    const durationX: number = 850;
    const shareX: number = 990;
    const rows: string[] = [];

    languageRows.forEach((entry: AllTimeLanguageEntry, index: number): void => {
        const y: number = headerHeight + index * rowHeight;
        const barFillWidth: number = Math.max(0, Math.round((entry.percentage / 100) * barWidth));
        const label: string = escapeXml(entry.label);
        const duration: string = escapeXml(entry.duration);
        const share: string = `${entry.percentage}%`;

        rows.push(`
  <g transform="translate(0 ${y})">
    ${getLanguageIconSvg(entry.language, iconX, 10, iconFolderPath)}
    <text x="${labelX}" y="28" class="label">${label}</text>
    <rect x="${barX}" y="16" width="${barWidth}" height="14" rx="7" class="track" />
    <rect x="${barX}" y="16" width="${barFillWidth}" height="14" rx="7" class="fill" />
    <text x="${durationX}" y="28" class="duration">${duration}</text>
    <text x="${shareX}" y="28" class="share">${share}</text>
  </g>`);
    });

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Coding Activity">
  <style>
    .card { fill: #0d1117; stroke: #30363d; stroke-width: 1.2; }
    .title { fill: #f0f6fc; font: 800 30px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; }
    .subtitle { fill: #8b949e; font: 500 15px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; }
    .meta { fill: #8b949e; font: 500 14px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; }
    .label { fill: #f0f6fc; font: 700 16px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; }
    .duration { fill: #c9d1d9; font: 700 15px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; text-anchor: end; }
    .share { fill: #8b949e; font: 600 14px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; text-anchor: end; }
    .track { fill: #21262d; }
    .fill { fill: #58a6ff; }
    .icon-bg { stroke: rgba(255, 255, 255, 0.18); stroke-width: 0.6; }
    .icon-text { fill: #ffffff; font: 800 11px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; text-anchor: middle; dominant-baseline: central; }
    .icon-mark { fill: #ffffff; font: 900 15px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; text-anchor: middle; dominant-baseline: central; }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="18" class="card" />
  <text x="${paddingX}" y="44" class="title">Coding Activity</text>
  <text x="${paddingX}" y="72" class="subtitle">Total tracked: ${escapeXml(summary.totalDuration)}</text>${rows.join('')}
  <text x="${paddingX}" y="${height - 28}" class="meta">Last update: ${escapeXml(summary.generatedAtLocal)}</text>
</svg>
`;
}

interface LanguageIconSpec {
    readonly color: string;
    readonly text: string;
}

function getLanguageIconSvg(language: string, x: number, y: number, iconFolderPath: string): string {
    const customIconSvg: string | undefined = getCustomLanguageIconSvg(language, iconFolderPath);

    if (customIconSvg !== undefined) {
        return `<g transform="translate(${x} ${y})">${customIconSvg}</g>`;
    }

    const spec: LanguageIconSpec = getLanguageIconSpec(language);
    const safeText: string = escapeXml(spec.text);

    return `<g transform="translate(${x} ${y})">
      <rect width="24" height="24" rx="6" fill="${spec.color}" class="icon-bg" />
      <text x="12" y="12" class="icon-text">${safeText}</text>
    </g>`;
}

function getCustomLanguageIconSvg(language: string, iconFolderPath: string): string | undefined {
    if (iconFolderPath.trim().length === 0) {
        return undefined;
    }

    const candidates: string[] = getLanguageIconCandidates(language);

    for (const candidate of candidates) {
        const iconPath: string = path.join(iconFolderPath, `${candidate}.svg`);

        try {
            if (!fs.existsSync(iconPath)) {
                continue;
            }

            const rawSvg: string = fs.readFileSync(iconPath, 'utf8');
            const normalizedSvg: string | undefined = normalizeCustomSvgIcon(rawSvg);

            if (normalizedSvg !== undefined) {
                return normalizedSvg;
            }
        } catch {
            continue;
        }
    }

    return undefined;
}

function getLanguageIconCandidates(language: string): string[] {
    const normalized: string = language.toLowerCase().trim();
    const aliases: Record<string, string[]> = {
        js: ['javascript'],
        ts: ['typescript'],
        md: ['markdown'],
        yml: ['yaml'],
        sh: ['shellscript', 'bash'],
        shell: ['shellscript', 'bash'],
        docker: ['dockerfile'],
        cs: ['csharp'],
        cplusplus: ['cpp'],
        text: ['plaintext'],
        none: ['text', 'plaintext']
    };

    return Array.from(new Set([normalized, ...(aliases[normalized] ?? [])]));
}

function normalizeCustomSvgIcon(rawSvg: string): string | undefined {
    const withoutUnsafeParts: string = rawSvg
        .replace(/^\uFEFF/, '')
        .replace(/<\?xml[\s\S]*?\?>/gi, '')
        .replace(/<!doctype[\s\S]*?>/gi, '')
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/\son[a-z]+=("[^"]*"|'[^']*')/gi, '')
        .trim();

    const match: RegExpMatchArray | null = withoutUnsafeParts.match(/^<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/i);

    if (match === null) {
        return undefined;
    }

    const rawAttributes: string = match[1];
    let innerSvg: string = match[2].trim();

    if (containsUnsafeSvgEmbedding(innerSvg)) {
        return undefined;
    }

    const viewBox: string = getSvgAttribute(rawAttributes, 'viewBox') ?? '0 0 24 24';
    const preserveAspectRatio: string | undefined = getSvgAttribute(rawAttributes, 'preserveAspectRatio');
    const idPrefix: string = `np-${crypto.createHash('sha1').update(rawSvg).digest('hex').slice(0, 10)}-`;

    innerSvg = prefixSvgIds(innerSvg, idPrefix);

    const preserveAspectRatioAttribute: string = preserveAspectRatio
        ? ` preserveAspectRatio="${escapeXml(preserveAspectRatio)}"`
        : '';

    return `<svg x="0" y="0" width="24" height="24" viewBox="${escapeXml(viewBox)}"${preserveAspectRatioAttribute}>${innerSvg}</svg>`;
}

function getSvgAttribute(attributes: string, name: string): string | undefined {
    const escapedName: string = escapeRegExp(name);
    const match: RegExpMatchArray | null = attributes.match(new RegExp(`\\s${escapedName}=("([^"]*)"|'([^']*)')`, 'i'));

    return match?.[2] ?? match?.[3];
}

function prefixSvgIds(svgContent: string, prefix: string): string {
    const ids: string[] = Array.from(svgContent.matchAll(/\sid=("|')([^"']+)\1/g)).map(
        (match: RegExpMatchArray): string => match[2]
    );

    let prefixedContent: string = svgContent;

    for (const id of ids) {
        const escapedId: string = escapeRegExp(id);
        const prefixedId: string = `${prefix}${id}`;

        prefixedContent = prefixedContent.replace(new RegExp(`id=("|')${escapedId}\\1`, 'g'), `id="${prefixedId}"`);
        prefixedContent = prefixedContent.replace(new RegExp(`url\\(#${escapedId}\\)`, 'g'), `url(#${prefixedId})`);
        prefixedContent = prefixedContent.replace(new RegExp(`(["'])#${escapedId}\\1`, 'g'), `$1#${prefixedId}$1`);
    }

    return prefixedContent;
}

function escapeRegExp(value: string): string {
    const specialCharacters: readonly string[] = ['\\', '^', '$', '*', '+', '?', '.', '(', ')', '|', '{', '}', '[', ']'];
    let escaped = '';

    for (const character of value) {
        escaped += specialCharacters.includes(character) ? `\\${character}` : character;
    }

    return escaped;
}

function containsUnsafeSvgEmbedding(innerSvg: string): boolean {
    return (
        /<(?:image|foreignObject)\b/i.test(innerSvg) ||
        /\s(?:href|xlink:href)=("|\')(?:https?:|data:|file:)/i.test(innerSvg)
    );
}

function getLanguageIconSpec(language: string): LanguageIconSpec {
    const normalized: string = language.toLowerCase();
    const icons: Record<string, LanguageIconSpec> = {
        python: { color: '#3776ab', text: 'Py' },
        typescript: { color: '#3178c6', text: 'TS' },
        javascript: { color: '#f7df1e', text: 'JS' },
        markdown: { color: '#6e7681', text: 'MD' },
        json: { color: '#cbcb41', text: '{}' },
        html: { color: '#e34f26', text: '<>' },
        css: { color: '#1572b6', text: '#' },
        scss: { color: '#cc6699', text: 'SC' },
        java: { color: '#e76f00', text: 'Jv' },
        csharp: { color: '#512bd4', text: 'C#' },
        cpp: { color: '#00599c', text: 'C+' },
        c: { color: '#555555', text: 'C' },
        go: { color: '#00add8', text: 'Go' },
        rust: { color: '#dea584', text: 'Rs' },
        lua: { color: '#000080', text: 'Lua' },
        dockerfile: { color: '#2496ed', text: 'Dk' },
        yaml: { color: '#cb171e', text: 'Y' },
        yml: { color: '#cb171e', text: 'Y' },
        shellscript: { color: '#4eaa25', text: 'Sh' },
        bash: { color: '#4eaa25', text: 'Sh' },
        powershell: { color: '#5391fe', text: 'PS' },
        xml: { color: '#e37933', text: 'XML' },
        sql: { color: '#336791', text: 'SQL' },
        plaintext: { color: '#6e7681', text: 'TXT' },
        none: { color: '#6e7681', text: '—' }
    };

    return icons[normalized] ?? { color: '#6e7681', text: normalized.slice(0, 3).toUpperCase() || '?' };
}

async function updateGitHubFileIfChanged(
    settings: GitHubProfileSettings,
    token: string,
    filePath: string,
    contentText: string,
    message: string
): Promise<boolean> {
    const currentFile: GitHubContentFile | null = await getGitHubContentFile(settings, token, filePath);

    if (currentFile !== null && currentFile.contentText === contentText) {
        return false;
    }

    await putGitHubContentFile(settings, token, {
        path: filePath,
        contentText,
        sha: currentFile?.sha,
        message
    });

    return true;
}

async function getGitHubContentFile(
    settings: GitHubProfileSettings,
    token: string,
    filePath: string
): Promise<GitHubContentFile | null> {
    const url: string = createGitHubContentsUrl(settings, filePath);
    const response = await fetch(url, {
        method: 'GET',
        headers: createGitHubHeaders(token)
    });

    const text: string = await response.text();

    if (response.status === 404) {
        return null;
    }

    if (!response.ok) {
        throw new Error(createGitHubErrorMessage(response.status, response.statusText, text));
    }

    const parsed: { path?: unknown; sha?: unknown; content?: unknown; encoding?: unknown; type?: unknown } = JSON.parse(text);

    if (parsed.type !== 'file' || typeof parsed.sha !== 'string' || typeof parsed.path !== 'string' || typeof parsed.content !== 'string') {
        throw new Error(`GitHub path is not a readable file: ${filePath}`);
    }

    return {
        path: parsed.path,
        sha: parsed.sha,
        contentText: Buffer.from(parsed.content.replace(/\n/g, ''), 'base64').toString('utf8')
    };
}

async function putGitHubContentFile(
    settings: GitHubProfileSettings,
    token: string,
    options: {
        readonly path: string;
        readonly contentText: string;
        readonly sha?: string;
        readonly message: string;
    }
): Promise<void> {
    const body: {
        message: string;
        content: string;
        branch: string;
        sha?: string;
    } = {
        message: options.message,
        content: Buffer.from(options.contentText, 'utf8').toString('base64'),
        branch: settings.branch
    };

    if (options.sha !== undefined) {
        body.sha = options.sha;
    }

    const response = await fetch(createGitHubContentsUrl(settings, options.path, false), {
        method: 'PUT',
        headers: createGitHubHeaders(token),
        body: JSON.stringify(body)
    });

    const text: string = await response.text();

    if (!response.ok) {
        throw new Error(createGitHubErrorMessage(response.status, response.statusText, text));
    }
}

function createGitHubContentsUrl(settings: GitHubProfileSettings, filePath: string, includeRef: boolean = true): string {
    const encodedOwner: string = encodeURIComponent(settings.owner);
    const encodedRepo: string = encodeURIComponent(settings.repo);
    const encodedPath: string = normalizeRepoPath(filePath).split('/').map((segment: string): string => encodeURIComponent(segment)).join('/');
    const baseUrl: string = `https://api.github.com/repos/${encodedOwner}/${encodedRepo}/contents/${encodedPath}`;

    if (!includeRef) {
        return baseUrl;
    }

    const refQuery: string = encodeURIComponent(settings.branch);
    return `${baseUrl}?ref=${refQuery}`;
}

function createGitHubHeaders(token: string): Record<string, string> {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'NixieePulse-VSCode-Extension'
    };
}

function createGitHubErrorMessage(status: number, statusText: string, responseText: string): string {
    try {
        const parsed: { message?: unknown } = JSON.parse(responseText);

        if (typeof parsed.message === 'string') {
            return `GitHub API ${status} ${statusText}: ${parsed.message}`;
        }
    } catch {
        // Ignore malformed error responses and fall through to the raw text.
    }

    return `GitHub API ${status} ${statusText}: ${responseText.slice(0, 300)}`;
}

function validateGitHubSettings(settings: GitHubProfileSettings): string | null {
    if (settings.owner.length === 0) {
        return 'NixieePulse GitHub sync needs nixieepulse.githubProfile.owner.';
    }

    if (settings.repo.length === 0) {
        return 'NixieePulse GitHub sync needs nixieepulse.githubProfile.repo.';
    }

    if (settings.readmePath.length === 0) {
        return 'NixieePulse GitHub sync needs nixieepulse.githubProfile.readmePath.';
    }

    if ((settings.mode === 'svg' || settings.mode === 'both') && settings.svgPath.length === 0) {
        return 'NixieePulse GitHub sync needs nixieepulse.githubProfile.svgPath when SVG mode is enabled.';
    }

    return null;
}

function createGitHubSetupGuide(settings: GitHubProfileSettings): string {
    return `# NixieePulse GitHub Profile Sync Setup

## 1. Create or use your profile README repository

For a GitHub profile README, the repository name should usually be the same as your GitHub username.

Example:

\`\`\`json
{
  "nixieepulse.githubProfile.owner": "YOUR_USERNAME",
  "nixieepulse.githubProfile.repo": "YOUR_USERNAME",
  "nixieepulse.githubProfile.branch": "main",
  "nixieepulse.githubProfile.readmePath": "README.md"
}
\`\`\`

## 2. Add markers to README.md

The extension updates only the block between these markers:

\`\`\`md
<!-- NIXIEEPULSE:START -->
<!-- NIXIEEPULSE:END -->
\`\`\`

If the markers are missing, the extension will append a new Coding Activity section to the README.

## 3. Create a fine-grained GitHub token

Recommended permissions:

- Repository access: only your profile README repository
- Repository permissions: Contents — Read and write
- Expiration: choose a reasonable expiration date

Then run:

\`\`\`text
NixieePulse: Set GitHub Token
\`\`\`

The token is stored in VS Code SecretStorage, not in settings.json.

## 4. Enable sync in settings

Current detected settings:

\`\`\`json
${JSON.stringify(settings, null, 2)}
\`\`\`

Minimum useful config:

\`\`\`json
{
  "nixieepulse.githubProfile.enabled": true,
  "nixieepulse.githubProfile.owner": "YOUR_USERNAME",
  "nixieepulse.githubProfile.repo": "YOUR_USERNAME",
  "nixieepulse.githubProfile.branch": "main",
  "nixieepulse.githubProfile.mode": "svg",
  "nixieepulse.githubProfile.autoSyncMinutes": 30,
  "nixieepulse.githubProfile.syncOnExit": true
}
\`\`\`

## 5. Test manually

Run:

\`\`\`text
NixieePulse: Sync GitHub Profile Now
\`\`\`
`;
}

function normalizeRepoPath(value: string): string {
    return value.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function isGitHubMode(value: string): value is 'markdown' | 'svg' | 'both' {
    return value === 'markdown' || value === 'svg' || value === 'both';
}

function clampInteger(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
        return min;
    }

    return Math.min(max, Math.max(min, Math.floor(value)));
}

function formatLanguageLabel(languageId: string): string {
    const knownLanguages: Record<string, string> = {
        bat: 'Batch',
        c: 'C',
        cpp: 'C++',
        csharp: 'C#',
        css: 'CSS',
        dockerfile: 'Dockerfile',
        go: 'Go',
        html: 'HTML',
        java: 'Java',
        javascript: 'JavaScript',
        json: 'JSON',
        jsonc: 'JSONC',
        lua: 'Lua',
        markdown: 'Markdown',
        php: 'PHP',
        powershell: 'PowerShell',
        python: 'Python',
        rust: 'Rust',
        shellscript: 'Shell',
        sql: 'SQL',
        typescript: 'TypeScript',
        yaml: 'YAML',
        xml: 'XML'
    };

    return knownLanguages[languageId] ?? languageId;
}

function escapeMarkdownCell(value: string): string {
    return value.replace(/\|/g, '\\|');
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function isDashboardMessage(value: unknown): value is DashboardMessage {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const candidate: { type?: unknown; command?: unknown } = value as { type?: unknown; command?: unknown };

    if (candidate.type === 'ready') {
        return true;
    }

    if (candidate.type !== 'command') {
        return false;
    }

    return candidate.command === 'refresh'
        || candidate.command === 'exportJson'
        || candidate.command === 'openJson'
        || candidate.command === 'resetToday';
}

function normalizeNixieePulseStats(value: unknown): NixieePulseStats | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }

    const candidate: Partial<NixieePulseStats> = value as Partial<NixieePulseStats>;

    if (candidate.version !== 1 || typeof candidate.days !== 'object' || candidate.days === null) {
        return null;
    }

    const createdAt: string = typeof candidate.createdAt === 'string' ? candidate.createdAt : new Date().toISOString();
    const updatedAt: string = typeof candidate.updatedAt === 'string' ? candidate.updatedAt : createdAt;
    const days: Record<string, DayStats> = {};

    for (const [dateKey, rawDayStats] of Object.entries(candidate.days)) {
        const normalizedDayStats: DayStats | null = normalizeDayStats(rawDayStats);

        if (normalizedDayStats !== null) {
            days[dateKey] = normalizedDayStats;
        }
    }

    return {
        version: 1,
        createdAt,
        updatedAt,
        days
    };
}

function normalizeDayStats(value: unknown): DayStats | null {
    if (typeof value !== 'object' || value === null) {
        return null;
    }

    const candidate: Partial<DayStats> = value as Partial<DayStats>;

    return {
        totalSeconds: normalizeSeconds(candidate.totalSeconds),
        projects: normalizeCounterMap(candidate.projects),
        languages: normalizeCounterMap(candidate.languages),
        files: normalizeCounterMap(candidate.files)
    };
}

function normalizeCounterMap(value: unknown): CounterMap {
    if (typeof value !== 'object' || value === null) {
        return {};
    }

    const normalized: CounterMap = {};

    for (const [key, rawSeconds] of Object.entries(value)) {
        const seconds: Seconds = normalizeSeconds(rawSeconds);

        if (key.trim().length > 0 && seconds > 0) {
            normalized[key] = seconds;
        }
    }

    return normalized;
}

function normalizeSeconds(value: unknown): Seconds {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return 0;
    }

    return Math.floor(value);
}
