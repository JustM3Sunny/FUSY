import { promises as fs } from "node:fs";
import path from "node:path";

export interface FileMetadata {
  path: string;
  extension: string;
  size: number;
  updatedAt: number;
}

export interface SymbolMetadata {
  filePath: string;
  line: number;
  name: string;
  kind: "function" | "class" | "interface" | "type" | "const";
}

export interface RepositoryIndex {
  rootPath: string;
  generatedAt: number;
  files: FileMetadata[];
  symbols: SymbolMetadata[];
}

export interface IndexerOptions {
  includeExtensions?: readonly string[];
  ignoreDirs?: readonly string[];
}

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".md"];
const DEFAULT_IGNORE_DIRS = [".git", "node_modules", "dist", "build", ".next", ".turbo"];

const SYMBOL_PATTERNS: Array<{ kind: SymbolMetadata["kind"]; pattern: RegExp }> = [
  { kind: "function", pattern: /^\s*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)/u },
  { kind: "class", pattern: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/u },
  { kind: "interface", pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/u },
  { kind: "type", pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/u },
  { kind: "const", pattern: /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/u }
];

export class RepositoryIndexer {
  async index(rootPath: string, options: IndexerOptions = {}): Promise<RepositoryIndex> {
    const files: FileMetadata[] = [];
    const symbols: SymbolMetadata[] = [];

    const includeExtensions = new Set(options.includeExtensions ?? DEFAULT_EXTENSIONS);
    const ignoreDirs = new Set(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);

    const walk = async (currentPath: string): Promise<void> => {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory() && ignoreDirs.has(entry.name)) {
          continue;
        }

        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
          continue;
        }

        const extension = path.extname(entry.name);
        if (!includeExtensions.has(extension)) {
          continue;
        }

        const stat = await fs.stat(fullPath);
        const relativePath = path.relative(rootPath, fullPath) || entry.name;

        files.push({
          path: relativePath,
          extension,
          size: stat.size,
          updatedAt: stat.mtimeMs
        });

        const content = await fs.readFile(fullPath, "utf8");
        const lines = content.split(/\r?\n/u);
        lines.forEach((line, index) => {
          for (const { kind, pattern } of SYMBOL_PATTERNS) {
            const match = line.match(pattern);
            if (match) {
              symbols.push({ filePath: relativePath, line: index + 1, name: match[1], kind });
              break;
            }
          }
        });
      }
    };

    await walk(rootPath);

    return {
      rootPath,
      generatedAt: Date.now(),
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
      symbols
    };
  }
}

export interface RetrievalCandidate {
  id: string;
  text: string;
  path?: string;
}

export interface SemanticRetriever {
  search(
    query: string,
    docs: readonly RetrievalCandidate[],
    limit: number
  ): Promise<Array<{ id: string; score: number }>>;
}

export interface HybridRetrievalResult {
  candidate: RetrievalCandidate;
  score: number;
  lexicalScore: number;
  semanticScore: number;
}

export interface HybridRetrievalOptions {
  limit?: number;
  lexicalWeight?: number;
  semanticWeight?: number;
}

export class HybridRetriever {
  constructor(private readonly semanticRetriever?: SemanticRetriever) {}

  async search(
    query: string,
    docs: readonly RetrievalCandidate[],
    options: HybridRetrievalOptions = {}
  ): Promise<HybridRetrievalResult[]> {
    const limit = options.limit ?? 8;
    const lexicalWeight = options.lexicalWeight ?? 0.6;
    const semanticWeight = options.semanticWeight ?? 0.4;

    const lexicalScores = new Map<string, number>(docs.map((doc) => [doc.id, this.lexicalScore(query, doc)]));
    const semanticScores = new Map<string, number>();

    if (this.semanticRetriever) {
      const semanticResults = await this.semanticRetriever.search(query, docs, limit * 2);
      semanticResults.forEach((result) => semanticScores.set(result.id, result.score));
    }

    return docs
      .map((doc) => {
        const lexicalScore = lexicalScores.get(doc.id) ?? 0;
        const semanticScore = semanticScores.get(doc.id) ?? 0;

        return {
          candidate: doc,
          lexicalScore,
          semanticScore,
          score: lexicalWeight * lexicalScore + semanticWeight * semanticScore
        };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  private lexicalScore(query: string, doc: RetrievalCandidate): number {
    const queryTerms = query.toLowerCase().split(/\s+/u).filter(Boolean);
    if (queryTerms.length === 0) {
      return 0;
    }

    const haystack = `${doc.path ?? ""}\n${doc.text}`.toLowerCase();
    let score = 0;

    for (const term of queryTerms) {
      if (haystack.includes(term)) {
        score += 1;
      }
    }

    return score / queryTerms.length;
  }
}

export interface ContextChunk {
  id: string;
  text: string;
  priority: number;
  tokenEstimate?: number;
}

export interface PackedContext {
  chunks: ContextChunk[];
  usedTokens: number;
  budget: number;
  droppedChunkIds: string[];
}

export interface ContextPackingOptions {
  tokenBudget: number;
  reservedTokens?: number;
}

const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / 4));

export class ContextPacker {
  pack(chunks: readonly ContextChunk[], options: ContextPackingOptions): PackedContext {
    const budget = Math.max(0, options.tokenBudget - (options.reservedTokens ?? 0));
    const selected: ContextChunk[] = [];
    const dropped: string[] = [];
    let usedTokens = 0;

    const ranked = [...chunks].sort((left, right) => {
      if (left.priority !== right.priority) {
        return right.priority - left.priority;
      }

      const leftTokens = left.tokenEstimate ?? estimateTokens(left.text);
      const rightTokens = right.tokenEstimate ?? estimateTokens(right.text);
      return leftTokens - rightTokens;
    });

    for (const chunk of ranked) {
      const tokens = chunk.tokenEstimate ?? estimateTokens(chunk.text);
      if (usedTokens + tokens <= budget) {
        selected.push({ ...chunk, tokenEstimate: tokens });
        usedTokens += tokens;
      } else {
        dropped.push(chunk.id);
      }
    }

    return { chunks: selected, usedTokens, budget, droppedChunkIds: dropped };
  }
}
