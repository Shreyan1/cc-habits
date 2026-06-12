// Pure parser functions, no vscode dependency, fully testable in Node.js.

export interface HabitItem {
  rule: string;
  confidence: number;
  sessions: number;
  category: string;
  isLearning: boolean;
}

export interface MemoryItem {
  text: string;
  trigger: string[];
  correction: string;
  confidence: number;
  seen: number;
  sessions: number;
  section: string;
  isCandidate: boolean;
}

export function parseHabitsFile(md: string): Map<string, HabitItem[]> {
  const result = new Map<string, HabitItem[]>();
  let currentCategory = '';
  let inLearning = false;
  let pendingRule: { rule: string; confidence: number; sessions?: number } | null = null;

  const flush = (sessions: number): void => {
    if (pendingRule && currentCategory) {
      const bucket = result.get(currentCategory) ?? [];
      bucket.push({
        rule: pendingRule.rule,
        confidence: pendingRule.confidence,
        sessions: pendingRule.sessions ?? sessions,
        category: currentCategory,
        isLearning: inLearning,
      });
      result.set(currentCategory, bucket);
      pendingRule = null;
    }
  };

  for (const line of md.split('\n')) {
    if (line.startsWith('## Learning')) {
      flush(1);
      inLearning = true;
      currentCategory = 'Learning';
      if (!result.has(currentCategory)) result.set(currentCategory, []);
      continue;
    }
    if (line.startsWith('## ')) {
      flush(inLearning ? 1 : 2);
      inLearning = false;
      currentCategory = line.slice(3).trim();
      if (!result.has(currentCategory)) result.set(currentCategory, []);
      continue;
    }
    if (line.startsWith('- ') && !line.startsWith('  -') && currentCategory) {
      flush(inLearning ? 1 : 2);
      const body = line.slice(2).trim().replace(/^\[[^\]]+\]\s*/, '');
      const m = body.match(/^(.+?)\.\s+Confidence:\s*([\d.]+)/);
      if (m) {
        pendingRule = { rule: m[1].trim(), confidence: parseFloat(m[2]) };
      }
      continue;
    }
    if (pendingRule && line.includes('Sessions seen:')) {
      const m = line.match(/Sessions seen:\s*(\d+)/);
      if (m) {
        pendingRule.sessions = parseInt(m[1], 10);
        flush(pendingRule.sessions);
      }
    }
  }
  flush(inLearning ? 1 : 2);
  return result;
}

export function parseMemoriesFile(md: string): Map<string, MemoryItem[]> {
  const result = new Map<string, MemoryItem[]>();
  let currentSection = '';
  let inCandidates = false;
  let current: Partial<MemoryItem> | null = null;

  const flush = (): void => {
    if (current?.text && currentSection) {
      const bucket = result.get(currentSection) ?? [];
      bucket.push({
        text: current.text,
        trigger: current.trigger ?? [],
        correction: current.correction ?? '',
        confidence: current.confidence ?? 0.50,
        seen: current.seen ?? 1,
        sessions: current.sessions ?? 1,
        section: currentSection,
        isCandidate: current.isCandidate ?? false,
      });
      result.set(currentSection, bucket);
      current = null;
    }
  };

  for (const line of md.split('\n')) {
    if (line.startsWith('## Candidates')) {
      flush();
      inCandidates = true;
      continue;
    }
    if (line.startsWith('## ')) {
      flush();
      currentSection = line.slice(3).trim();
      inCandidates = false;
      if (!result.has(currentSection)) result.set(currentSection, []);
      continue;
    }
    if (line.startsWith('- ') && !line.startsWith('  -')) {
      flush();
      let body = line.slice(2).trim();
      let targetSection = currentSection;
      if (inCandidates) {
        const m = body.match(/^\[([^\]]+)\]\s+(.+)$/);
        if (!m || !m[1] || !m[2]) continue;
        targetSection = m[1].trim();
        body = m[2].trim();
      }
      if (!targetSection) continue;
      if (!result.has(targetSection)) result.set(targetSection, []);
      currentSection = targetSection;
      current = {
        text: body.replace(/\.$/, ''),
        trigger: [],
        isCandidate: inCandidates,
        confidence: inCandidates ? 0.50 : 0.70,
        sessions: inCandidates ? 1 : 2,
      };
      continue;
    }
    if (!current) continue;
    const t = line.trim();
    if (t.startsWith('- Trigger:')) {
      current.trigger = t.split(':').slice(1).join(':').split(',').map(s => s.trim()).filter(Boolean);
    } else if (t.startsWith('- Correction:')) {
      current.correction = t.split(':').slice(1).join(':').trim();
    } else if (t.startsWith('- Confidence:')) {
      const n = parseFloat(t.split(':').slice(1).join(':').trim());
      if (!Number.isNaN(n)) current.confidence = n;
    } else if (t.startsWith('- Sessions seen:')) {
      const n = parseInt(t.split(':').slice(1).join(':').trim(), 10);
      if (!Number.isNaN(n)) current.sessions = n;
    } else if (t.startsWith('- Seen:')) {
      const n = parseInt(t.split(':').slice(1).join(':').trim(), 10);
      if (!Number.isNaN(n)) current.seen = n;
    }
  }
  flush();
  return result;
}
