import {
  type CosImageAttachment,
  type CosElementRef,
} from '../lib/chief-of-staff.js';
import { UnifiedComposer, type UnifiedComposerData } from './UnifiedComposer.js';

// Slack-mode thread composer. Wraps <UnifiedComposer> so screenshot / DOM
// pick / console / mic / paste-image / draft-autosave behavior matches the
// session-resume bar. Submit converts captured blobs into dataUrl
// CosImageAttachments before handing them to the caller's send pipeline
// (sendChiefOfStaffMessage), preserving the dataUrl-based attachment shape
// that the rest of the CoS chat machinery expects.

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export interface CosComposerProps {
  placeholder: string;
  /** Called when the operator hits Enter or clicks send. The caller
   *  dispatches via sendChiefOfStaffMessage. */
  onSend: (text: string, attachments: CosImageAttachment[], elementRefs: CosElementRef[]) => void;
  /** Stable thread identifier used as the draft-storage key — autosave/restore
   *  via /api/v1/admin/drafts/cos:<threadId>. Pass null/undefined for the
   *  bubble's "new top-level thread" compose where draft persistence isn't
   *  desired (or use a synthetic key). */
  threadId?: string | null;
  /** Optional: parent-scoped Escape handler — fired when Escape is pressed
   *  with empty text. */
  onEscapeWhenEmpty?: () => void;
  /** Visual hint that the agent is streaming a reply. */
  disabled?: boolean;
  /** Auto-grow textarea row count while typing. */
  rows?: number;
}

export function CosComposer({
  placeholder,
  onSend,
  threadId,
  onEscapeWhenEmpty,
  disabled,
  rows = 2,
}: CosComposerProps) {
  async function handleSubmit(data: UnifiedComposerData) {
    const { text, images, imageNames, elements, consoleEntries, voice } = data;
    // CoS sendChiefOfStaffMessage expects dataUrl-based image attachments.
    // Convert blobs first so the caller doesn't need to know about Blobs.
    const imageAttachments: CosImageAttachment[] = await Promise.all(
      images.map(async (blob, i) => ({
        kind: 'image' as const,
        dataUrl: await blobToDataUrl(blob),
        name: imageNames[i],
      })),
    );
    // CoS message pipeline doesn't have a console/voice channel — fold any
    // console capture and final voice transcript into the prompt body so the
    // information isn't lost when an operator records via the menu.
    let finalText = text;
    if (consoleEntries && consoleEntries.length > 0) {
      const body = consoleEntries
        .slice(-30)
        .map((e) => `[${e.level}] ${e.text}`)
        .join('\n');
      finalText = `${finalText}${finalText ? '\n\n' : ''}--- Console snapshot:\n${body}`;
    }
    if (voice) {
      const transcript = voice.transcript
        .filter((t) => t.isFinal)
        .map((t) => t.text.trim())
        .filter(Boolean)
        .join(' ');
      if (transcript) {
        finalText = `${finalText}${finalText ? '\n\n' : ''}--- Voice transcript: ${transcript}`;
      }
    }
    const elementRefs: CosElementRef[] = elements.map((e) => ({
      selector: e.selector,
      tagName: e.tagName,
      id: e.id || undefined,
      classes: e.classes,
      textContent: e.textContent,
      boundingRect: e.boundingRect,
      attributes: e.attributes,
    }));
    onSend(finalText, imageAttachments, elementRefs);
  }

  return (
    <UnifiedComposer
      className="cos-composer"
      placeholder={placeholder}
      submitTitle="Send (Enter)"
      submitIcon="send"
      submitAriaLabel="Send"
      draftKey={threadId ? `cos:${threadId}` : undefined}
      disabled={disabled}
      onSubmit={handleSubmit}
      onEscapeWhenEmpty={onEscapeWhenEmpty}
      rows={rows}
    />
  );
}
