import { AgentTerminal } from './AgentTerminal.js';

interface TerminalCompanionViewProps {
  companionSessionId: string;
}

export function TerminalCompanionView({ companionSessionId }: TerminalCompanionViewProps) {
  return (
    <AgentTerminal sessionId={companionSessionId} isActive={true} />
  );
}
