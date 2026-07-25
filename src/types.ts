// Observer Protocol Type Definitions

export interface ObserverConfig {
  vault_path: string;
  identity: {
    owner: string;
    context_file?: string;
  };
  domains: DomainMapping[];
  rules: Rules;
  outputs: {
    allowed_paths: string[];
  };
  restricted: {
    patterns: string[];
  };
  reflection?: ReflectionConfig;
  negation?: NegationConfig;
}

export interface DomainMapping {
  keywords: string[];
  context: string;
}

export interface Rules {
  read_before_edit: boolean;
  no_sycophancy: boolean;
  no_slop_rhythm: boolean;
  require_correction_acknowledgment: boolean;
}

export interface ReflectionConfig {
  recurrence_threshold: number;
  contradiction_check: boolean;
  absence_check: boolean;
  drift_sensitivity: 'low' | 'medium' | 'high';
  rhythm_tracking: boolean;
}

export interface NegationConfig {
  agent_self_monitor: boolean;
  user_drift_detection: boolean;
  user_drift_mode: 'silent' | 'surface';
}


// Loop Types

export interface LoopConfig {
  id: string;
  type: 'interval' | 'completion' | 'trigger';
  status: 'active' | 'paused' | 'complete';
  objective: string;
  source: {
    paths: string[];
    filter?: string;
  };
  constraints: {
    privacy_weight: number;
    restricted_topics: string[];
    max_per_day?: number;
    platforms?: string[];
  };
  schedule?: {
    type: 'interval' | 'cron';
    value: string;
    jitter?: string;
    active_hours?: [number, number];
  };
  transform?: TransformStep[];
  output: {
    log_path: string;
    draft_path?: string;
    require_approval: boolean;
  };
  on_complete: 'pause' | 'archive' | 'delete' | 'mark_source_posted';
}

export interface TransformStep {
  action: 'extract' | 'apply' | 'check' | 'validate';
  target: string;
}

export interface LoopState {
  id: string;
  status: 'active' | 'paused' | 'complete';
  last_run?: string;
  next_run?: string;
  runs_today: number;
  history: LoopRun[];
}

export interface LoopRun {
  timestamp: string;
  status: 'success' | 'failed' | 'skipped' | 'pending_approval';
  output?: string;
  error?: string;
}

// Intake Types

export interface IntakeEntry {
  type: 'voice' | 'text';
  source: string;
  captured: string;
  duration?: number;
  avg_pace?: number;
  pauses?: number[];
  content: string;
}

// Correction Types

export interface Correction {
  ts: string;
  type: 'rhythm' | 'sycophancy' | 'verbosity' | 'interpretation' | 'persona' | 'leading' | 'framework' | 'architecture' | 'voice';
  trigger: string;
  action: 'stop' | 'remove' | 'truncate' | 'restructure';
  domain?: string;
  severity?: 'critical' | 'high' | 'medium' | 'low';
  framework_violated?: string; // e.g., "PASAIDA", "Abrasivism", "Koray"
}

export interface Pattern {
  type: string;
  triggers: string[];
  count: number;
  last_seen: string;
  auto_correct: boolean;
  framework?: string; // Which framework this pattern relates to
}

// Observation Types (aligned with vault schema)

export interface Observation {
  type: 'observation';
  category: 'feedback' | 'error' | 'pattern' | 'insight' | 'maintenance' | 'drift';
  domain?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'pending' | 'acknowledged' | 'resolved' | 'archived';
  created: string;
  resolved?: string;
  affected_files?: string[];
  correction?: string;
  success_criteria?: string;
  relevant?: string[]; // Wikilinks to related notes
}

// Maintenance Flag (vault health)

export interface MaintenanceFlag {
  file_path: string;
  issue: 'stale_progress' | 'orphan_file' | 'missing_backlinks' | 'contradictory_data' | 'outdated_context';
  detected: string;
  priority: 1 | 2 | 3 | 4;
  suggested_action: string;
  resolved?: string;
}

// Quality Gate (pre/post validation)

export interface QualityGate {
  phase: 'pre' | 'post' | 'maintenance';
  name: string;
  check: string;
  passed: boolean;
  notes?: string;
}

// Energy-based Task (aligned with vault productivity system)

export interface EnergyTask {
  type: 'task';
  domain: string;
  status: 'inbox' | 'next' | 'doing' | 'done' | 'waiting' | 'cancelled';
  energy: 'deep' | 'quick' | 'creative' | 'admin';
  due?: string;
  estimate?: number;
  created: string;
  completed?: string;
  content: string;
}
