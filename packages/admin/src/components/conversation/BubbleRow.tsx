import type { ComponentChildren } from 'preact';
import { MessageAvatar, Timestamp } from '../cos/CosMessage.js';

export interface BubbleRowProps {
  /** 'user' | 'assistant' or any string — controls avatar style and row class */
  role: string;
  /** Display name shown in the header (e.g. "You", "Ops") */
  authorLabel: string;
  /** Optional avatar image URL (passed to MessageAvatar) */
  avatarSrc?: string | null;
  /** Unix-ms timestamp — omit to hide the time chip */
  timestamp?: number;
  /** When true, suppresses the timestamp (still streaming) */
  streaming?: boolean;
  /** Extra CSS classes appended to the outer .cos-row element */
  className?: string;
  /** data-cos-msg-idx forwarded to the outer element */
  msgIdx?: number;
  children: ComponentChildren;
}

/**
 * Reusable bubble wrapper shared by CoS messages and (future) ConversationView.
 *
 * Renders:
 *   .cos-row > .cos-row-avatar + .cos-row-main > .cos-row-header + children
 *
 * Intentionally thin: no business logic, just the visual chrome that wraps
 * arbitrary message content (tool chips, markdown prose, attachments, etc.).
 */
export function BubbleRow({
  role,
  authorLabel,
  avatarSrc,
  timestamp,
  streaming,
  className,
  msgIdx,
  children,
}: BubbleRowProps) {
  const extraCls = className ? ` ${className}` : '';
  return (
    <div
      class={`cos-row cos-row-${role}${extraCls}`}
      data-cos-msg-idx={msgIdx}
    >
      <div class="cos-row-avatar">
        <MessageAvatar role={role} label={authorLabel} imageSrc={avatarSrc} />
      </div>
      <div class="cos-row-main">
        <div class="cos-row-header">
          <span class="cos-row-author">{authorLabel}</span>
          {timestamp != null && !streaming && <Timestamp ts={timestamp} />}
        </div>
        {children}
      </div>
    </div>
  );
}
