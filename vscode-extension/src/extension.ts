import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import {
  parseHabitsFile, parseMemoriesFile, parsePendingFile,
  type HabitItem, type MemoryItem, type PendingItem,
} from './parsers';
import { activateCollector } from './collector';

// Storage root ──────────────────────────────────────────────────────────────

function habitsDir(): string {
  return process.env['CC_HABITS_DIR'] ?? path.join(os.homedir(), '.cc-habits');
}

function habitsFilePath(): string { return path.join(habitsDir(), 'habits.md'); }
function memoriesFilePath(): string { return path.join(habitsDir(), 'memories.md'); }
function pendingFilePath(): string { return path.join(habitsDir(), '.pending.json'); }

// CLI runner ────────────────────────────────────────────────────────────────

function runCli(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise(resolve => {
    const config = vscode.workspace.getConfiguration('cchabits');
    let customPath = config.get<string>('cliPath') || '';
    if (customPath.startsWith('~/')) {
      customPath = path.join(os.homedir(), customPath.slice(2));
    }
    const candidates = customPath ? [customPath] : ['cc-habits', 'cch'];
    let tried = 0;

    const tryNext = (): void => {
      if (tried >= candidates.length) {
        resolve({ ok: false, out: '', err: 'cc-habits not found. Install with: npm install -g cc-habits' });
        return;
      }
      const cmd = candidates[tried++];
      const proc = spawn(cmd, args, { env: { ...process.env }, timeout: 15000, shell: false });
      let out = '';
      let err = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('close', code => resolve({ ok: code === 0, out, err }));
      proc.on('error', tryNext);
    };

    tryNext();
  });
}

// Tree item types ───────────────────────────────────────────────────────────

type NodeKind = 'habitCategory' | 'habit' | 'memorySection' | 'memory' | 'pendingItem' | 'empty';

class CcNode extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly kind: NodeKind,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly payload?: HabitItem | MemoryItem | PendingItem,
  ) {
    super(label, collapsible);
    this.contextValue = kind;
    this._decorate();
  }

  private _decorate(): void {
    switch (this.kind) {
      case 'empty':
        this.iconPath = new vscode.ThemeIcon('info');
        break;
      case 'habitCategory':
      case 'memorySection':
        this.iconPath = new vscode.ThemeIcon('symbol-namespace');
        break;
      case 'habit': {
        const h = this.payload as HabitItem;
        const pct = Math.round(h.confidence * 100);
        this.description = h.isLearning ? `${pct}% · learning` : `${pct}%`;
        this.tooltip = new vscode.MarkdownString(
          `**${h.rule}**\n\nConfidence: ${pct}%  \nCategory: ${h.category}  \nSessions: ${h.sessions}`,
        );
        this.iconPath = h.isLearning
          ? new vscode.ThemeIcon('circle-outline')
          : new vscode.ThemeIcon('circle-filled');
        break;
      }
      case 'memory': {
        const m = this.payload as MemoryItem;
        const pct = Math.round(m.confidence * 100);
        this.description = m.isCandidate ? `${pct}% · candidate` : `${pct}%`;
        const tip = [`**${m.text}**`];
        if (m.correction) tip.push(`\nCorrection: ${m.correction}`);
        if (m.trigger.length > 0) tip.push(`\nTrigger: ${m.trigger.join(', ')}`);
        tip.push(`\nSeen: ${m.seen}x  ·  Sessions: ${m.sessions}`);
        this.tooltip = new vscode.MarkdownString(tip.join(''));
        this.iconPath = m.isCandidate
          ? new vscode.ThemeIcon('circle-outline')
          : new vscode.ThemeIcon('warning');
        break;
      }
      case 'pendingItem': {
        const p = this.payload as PendingItem;
        this.description = p.category;
        this.tooltip = p.reasoning || p.rule;
        this.iconPath = new vscode.ThemeIcon('clock');
        break;
      }
    }
  }
}

// HabitsProvider ────────────────────────────────────────────────────────────

class HabitsProvider implements vscode.TreeDataProvider<CcNode> {
  private readonly _change = new vscode.EventEmitter<CcNode | undefined | null>();
  readonly onDidChangeTreeData = this._change.event;

  refresh(): void { this._change.fire(null); }
  getTreeItem(el: CcNode): CcNode { return el; }

  getChildren(el?: CcNode): CcNode[] {
    if (!el) return this._categories();
    if (el.kind === 'habitCategory') return this._habits(el.label as string);
    return [];
  }

  private _categories(): CcNode[] {
    const f = habitsFilePath();
    if (!fs.existsSync(f)) {
      return [new CcNode('Run cc-habits init to get started', 'empty', vscode.TreeItemCollapsibleState.None)];
    }
    const cats = parseHabitsFile(fs.readFileSync(f, 'utf-8'));
    if (cats.size === 0) {
      return [new CcNode('No habits yet — use Claude Code for a session', 'empty', vscode.TreeItemCollapsibleState.None)];
    }
    return Array.from(cats.keys()).map(cat =>
      new CcNode(cat, 'habitCategory', vscode.TreeItemCollapsibleState.Expanded),
    );
  }

  private _habits(category: string): CcNode[] {
    const f = habitsFilePath();
    if (!fs.existsSync(f)) return [];
    const cats = parseHabitsFile(fs.readFileSync(f, 'utf-8'));
    return (cats.get(category) ?? []).map(h =>
      new CcNode(h.rule, 'habit', vscode.TreeItemCollapsibleState.None, h),
    );
  }
}

// MemoriesProvider ──────────────────────────────────────────────────────────

class MemoriesProvider implements vscode.TreeDataProvider<CcNode> {
  private readonly _change = new vscode.EventEmitter<CcNode | undefined | null>();
  readonly onDidChangeTreeData = this._change.event;

  refresh(): void { this._change.fire(null); }
  getTreeItem(el: CcNode): CcNode { return el; }

  getChildren(el?: CcNode): CcNode[] {
    if (!el) return this._sections();
    if (el.kind === 'memorySection') return this._memories(el.label as string);
    return [];
  }

  private _sections(): CcNode[] {
    const f = memoriesFilePath();
    if (!fs.existsSync(f)) {
      return [new CcNode('No memories yet — set CC_HABITS_MEMORIES=1', 'empty', vscode.TreeItemCollapsibleState.None)];
    }
    const sections = parseMemoriesFile(fs.readFileSync(f, 'utf-8'));
    const allMemories = Array.from(sections.values()).flat();
    if (allMemories.length === 0) {
      return [new CcNode('No memories recorded yet', 'empty', vscode.TreeItemCollapsibleState.None)];
    }
    return Array.from(sections.keys()).map(sec =>
      new CcNode(sec, 'memorySection', vscode.TreeItemCollapsibleState.Expanded),
    );
  }

  private _memories(section: string): CcNode[] {
    const f = memoriesFilePath();
    if (!fs.existsSync(f)) return [];
    const sections = parseMemoriesFile(fs.readFileSync(f, 'utf-8'));
    return (sections.get(section) ?? []).map(m =>
      new CcNode(m.text, 'memory', vscode.TreeItemCollapsibleState.None, m),
    );
  }
}

// PendingProvider ───────────────────────────────────────────────────────────

class PendingProvider implements vscode.TreeDataProvider<CcNode> {
  private readonly _change = new vscode.EventEmitter<CcNode | undefined | null>();
  readonly onDidChangeTreeData = this._change.event;

  refresh(): void { this._change.fire(null); }
  getTreeItem(el: CcNode): CcNode { return el; }

  getChildren(el?: CcNode): CcNode[] {
    if (el) return [];
    const f = pendingFilePath();
    if (!fs.existsSync(f)) {
      return [new CcNode('No pending habits', 'empty', vscode.TreeItemCollapsibleState.None)];
    }
    const items = parsePendingFile(fs.readFileSync(f, 'utf-8'));
    if (items.length === 0) {
      return [new CcNode('No pending habits', 'empty', vscode.TreeItemCollapsibleState.None)];
    }
    return items.map(p =>
      new CcNode(p.rule, 'pendingItem', vscode.TreeItemCollapsibleState.None, p),
    );
  }
}

// activate ──────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  const habitsProvider = new HabitsProvider();
  const memoriesProvider = new MemoriesProvider();
  const pendingProvider = new PendingProvider();

  context.subscriptions.push(
    vscode.window.createTreeView('cchabits.habits', {
      treeDataProvider: habitsProvider,
      showCollapseAll: true,
    }),
    vscode.window.createTreeView('cchabits.memories', {
      treeDataProvider: memoriesProvider,
      showCollapseAll: true,
    }),
    vscode.window.createTreeView('cchabits.pending', {
      treeDataProvider: pendingProvider,
    }),
  );

  // Watch habits dir for file changes and auto-refresh
  const dir = habitsDir();
  if (fs.existsSync(dir)) {
    const mdWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), '*.md'),
    );
    mdWatcher.onDidChange(() => { habitsProvider.refresh(); memoriesProvider.refresh(); });
    mdWatcher.onDidCreate(() => { habitsProvider.refresh(); memoriesProvider.refresh(); });
    context.subscriptions.push(mdWatcher);

    const pendingWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dir), '.pending.json'),
    );
    pendingWatcher.onDidChange(() => pendingProvider.refresh());
    pendingWatcher.onDidCreate(() => pendingProvider.refresh());
    pendingWatcher.onDidDelete(() => pendingProvider.refresh());
    context.subscriptions.push(pendingWatcher);
  }

  // File save watcher for live capture
  activateCollector(context, runCli);

  // Commands ─────────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('cchabits.refresh', () => {
      habitsProvider.refresh();
      memoriesProvider.refresh();
      pendingProvider.refresh();
    }),

    vscode.commands.registerCommand('cchabits.openHabits', () => {
      const f = habitsFilePath();
      if (fs.existsSync(f)) {
        void vscode.window.showTextDocument(vscode.Uri.file(f));
      } else {
        void vscode.window.showWarningMessage('habits.md not found. Run: cc-habits init');
      }
    }),

    vscode.commands.registerCommand('cchabits.openMemories', () => {
      const f = memoriesFilePath();
      if (fs.existsSync(f)) {
        void vscode.window.showTextDocument(vscode.Uri.file(f));
      } else {
        void vscode.window.showWarningMessage('memories.md not found. Run: cc-habits init, then set CC_HABITS_MEMORIES=1');
      }
    }),

    vscode.commands.registerCommand('cchabits.tombstone', async (node: CcNode) => {
      if (!node || node.kind !== 'habit') return;
      const habit = node.payload as HabitItem;
      const answer = await vscode.window.showWarningMessage(
        `Tombstone "${habit.rule}"?\n\nIt will never be re-learned.`,
        { modal: true },
        'Tombstone',
      );
      if (answer !== 'Tombstone') return;
      const result = await runCli(['tombstone', habit.rule]);
      if (result.ok) {
        habitsProvider.refresh();
        void vscode.window.showInformationMessage(`Tombstoned: ${habit.rule}`);
      } else {
        void vscode.window.showErrorMessage(result.err || 'cc-habits not found. Install: npm install -g cc-habits');
      }
    }),

    vscode.commands.registerCommand('cchabits.deleteMemory', async (node: CcNode) => {
      if (!node || node.kind !== 'memory') return;
      const memory = node.payload as MemoryItem;
      const answer = await vscode.window.showWarningMessage(
        `Delete memory?\n\n"${memory.text}"\n\nIt will not be re-learned.`,
        { modal: true },
        'Delete',
      );
      if (answer !== 'Delete') return;
      const result = await runCli(['memories', '--delete', memory.text]);
      if (result.ok) {
        memoriesProvider.refresh();
        void vscode.window.showInformationMessage('Memory deleted and tombstoned.');
      } else {
        void vscode.window.showErrorMessage(result.err || 'cc-habits not found.');
      }
    }),

    vscode.commands.registerCommand('cchabits.approvePending', async () => {
      const result = await runCli(['pending', '--approve']);
      if (result.ok) {
        habitsProvider.refresh();
        pendingProvider.refresh();
        void vscode.window.showInformationMessage('Pending habits approved and applied.');
      } else {
        void vscode.window.showErrorMessage(result.err || 'cc-habits not found.');
      }
    }),

    vscode.commands.registerCommand('cchabits.discardPending', async () => {
      const answer = await vscode.window.showWarningMessage(
        'Discard all pending habit proposals?',
        { modal: true },
        'Discard',
      );
      if (answer !== 'Discard') return;
      const result = await runCli(['pending', '--discard']);
      if (result.ok) {
        pendingProvider.refresh();
        void vscode.window.showInformationMessage('Pending habits discarded.');
      } else {
        void vscode.window.showErrorMessage(result.err || 'cc-habits not found.');
      }
    }),

    vscode.commands.registerCommand('cchabits.sync', async () => {
      const result = await runCli(['sync']);
      if (result.ok) {
        void vscode.window.showInformationMessage('cc-habits synced to AGENTS.md / Cursor / Cline.');
      } else {
        void vscode.window.showErrorMessage(`Sync failed: ${result.err || 'cc-habits not found.'}`);
      }
    }),
  );
}

export function deactivate(): void { /* nothing to clean up */ }
