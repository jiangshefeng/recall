export type RetrievalMode = "expand" | "sources";
export type StageSummary = {
  id: string;
  content: string;
  sourceIds: string[];
  createdAt: string;
};
export type Memory = {
  id: string;
  scope: string;
  summary: string;
  kind?: "fact" | "qa";
  vector: number[];
  space: string;
  status: "hot" | "cold";
  sourceIds: string[];
  parentIds: string[];
  reason: string;
  createdAt: string;
  stage?: StageSummary;
};
export type RecordEntry = {
  id: string;
  scope: string;
  question: string;
  answer: string;
  context: string;
  createdAt: string;
};
export type Hit = Omit<Memory, "vector"> & {
  score: number;
  via?: string;
  originalScore?: number;
  neighborScore?: number;
  includedSourceIds?: string[];
};
export type RetrievalPolicy = {
  firstCandidates: number;
  firstLimit: number;
  neighborsPerSeed: number;
  secondLimit: number;
  maxRecords: number;
  maxContextChars: number;
  maxEstimatedTokens: number;
  maxRecordChars: number;
  minFirstResults: number;
  minStrongResults: number;
  strongScore: number;
};
export type PromptEvidence = {
  kind?: "stage";
  sourceCount?: number;
  citation: number;
  id: string;
  date: string;
  content: string;
  truncated: boolean;
};
export type ExpansionReason = "sources-only" | "no-first-results" | "budget-exhausted" | "enough-first-results" | "few-first-results" | "few-strong-results";
export type Evidence = {
  stages?: StageSummary[];
  suggestions?: Hit[];
  first: Hit[];
  second: Hit[];
  records: RecordEntry[];
  strategy: RetrievalMode;
  context: PromptEvidence[];
  trace: {
    expanded: boolean;
    reason: ExpansionReason;
    firstCandidates: number;
    strongFirstResults: number;
    minScore: number;
    policy: RetrievalPolicy;
    usage: { records: number; chars: number; estimatedTokens: number; truncatedRecords: number };
  };
};
export type Turn = { role: "user" | "assistant"; content: string };
