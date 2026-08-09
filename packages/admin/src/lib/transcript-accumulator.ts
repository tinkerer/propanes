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

  get hasMessages(): boolean {
    for (const parser of this.parsers.values()) {
      if (parser.getMessages().length > 0) return true;
    }
    return false;
  }

  apply(
    runtime: string | undefined,
    order: string[],
    files: TranscriptDeltaFile[],
    reset: boolean,
  ): ParsedMessage[] {
    if (reset) this.parsers.clear();

    for (const file of files) {
      let parser = this.parsers.get(file.key);
      if (!parser) {
        parser = runtime === 'codex' ? new CodexOutputParser() : new JsonOutputParser();
        this.parsers.set(file.key, parser);
      }
      if (file.lines) parser.feed(file.lines + '\n');
    }

    return order.flatMap((key) => {
      const parser = this.parsers.get(key);
      if (!parser) return [];
      // Parser-local ids start at the same value for every physical file.
      // Namespace them so keyed Preact children remain stable and unique in
      // merged main/continuation/subagent transcripts.
      return parser.getMessages().map((message) => ({
        ...message,
        id: `${key}:${message.id}`,
      }));
    });
  }
}
