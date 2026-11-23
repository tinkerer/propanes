import { JsonOutputParser, type ParsedMessage } from './output-parser.js';
import { CodexOutputParser } from './codex-output-parser.js';

interface TranscriptDeltaFile {
  key: string;
  lines: string;
}

/** Incrementally parse each physical JSONL file, then merge their parsed
 * messages in the order supplied by the server. A Claude session that has
 * grown large enough to compact can contain tens of thousands of lines. The
 * old implementation appended the small network delta to a text buffer and
 * reparsed the entire transcript every three seconds, which eventually made
 * the structured view look as though it had stopped following the session.
 *
 * Keeping a parser per file also preserves the server's merge semantics for
 * continuation/subagent files: an append to the main file does not require
 * replaying subagent files that follow it in the merged order. */
export class TranscriptAccumulator {
  private parsers = new Map<string, JsonOutputParser | CodexOutputParser>();
  /** Earlier-history pages per file, oldest first. Each page gets its own
   *  parser: prepending can't go through the live parser (it only appends),
   *  and reparsing the loaded tail on every page would defeat paging. */
  private history = new Map<string, Array<{ page: number; parser: JsonOutputParser | CodexOutputParser }>>();
  private historyPages = 0;
  private order: string[] = [];

  get hasMessages(): boolean {
    for (const parser of this.parsers.values()) {
      if (parser.getMessages().length > 0) return true;
    }
    for (const pages of this.history.values()) {
      if (pages.some(({ parser }) => parser.getMessages().length > 0)) return true;
    }
    return false;
  }

  apply(
    runtime: string | undefined,
    order: string[],
    files: TranscriptDeltaFile[],
    reset: boolean,
  ): ParsedMessage[] {
    if (reset) {
      this.parsers.clear();
      this.history.clear();
    }
    this.order = order;

    for (const file of files) {
      let parser = this.parsers.get(file.key);
      if (!parser) {
        parser = newParser(runtime);
        this.parsers.set(file.key, parser);
      }
      if (file.lines) parser.feed(file.lines + '\n');
    }

    return this.merged();
  }

  /** Prepend a page of earlier history (lines just below what's loaded for
   *  each file). */
  prepend(runtime: string | undefined, order: string[], files: TranscriptDeltaFile[]): ParsedMessage[] {
    if (order.length > 0) this.order = order;
    for (const file of files) {
      if (!file.lines) continue;
      const parser = newParser(runtime);
      parser.feed(file.lines + '\n');
      const pages = this.history.get(file.key) || [];
      pages.unshift({ page: ++this.historyPages, parser });
      this.history.set(file.key, pages);
    }
    return this.merged();
  }

  private merged(): ParsedMessage[] {
    return this.order.flatMap((key) => {
      // Parser-local ids start at the same value for every physical file (and
      // every history page). Namespace them so keyed Preact children remain
      // stable and unique in merged main/continuation/subagent transcripts.
      const out: ParsedMessage[] = [];
      for (const { page, parser } of this.history.get(key) || []) {
        for (const message of parser.getMessages()) out.push({ ...message, id: `${key}:h${page}:${message.id}` });
      }
      const parser = this.parsers.get(key);
      if (parser) {
        for (const message of parser.getMessages()) out.push({ ...message, id: `${key}:${message.id}` });
      }
      return out;
    });
  }
}

function newParser(runtime: string | undefined): JsonOutputParser | CodexOutputParser {
  return runtime === 'codex' ? new CodexOutputParser() : new JsonOutputParser();
}
