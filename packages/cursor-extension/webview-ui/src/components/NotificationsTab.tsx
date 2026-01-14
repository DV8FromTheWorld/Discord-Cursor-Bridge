import React, { useState, useCallback } from 'react';
import { WebviewState, ThreadCreationNotify, MessagePingMode } from '../types';
import { postMessage } from '../vscode';
import { Section, Button, HelpText, Callout } from './shared';

interface Props {
  state: WebviewState;
}

export default function NotificationsTab({ state }: Props) {
  const { 
    guildId, 
    threadInviteUserIds, 
    threadCreationNotify, 
    messagePingMode 
  } = state;

  const [userIdsInput, setUserIdsInput] = useState(threadInviteUserIds.join('\n'));

  const handleSaveInviteUsers = useCallback(() => {
    postMessage({ type: 'saveInviteUsers', userIds: userIdsInput });
  }, [userIdsInput]);

  const handleSetThreadCreationNotify = useCallback((mode: ThreadCreationNotify) => {
    postMessage({ type: 'setThreadCreationNotify', mode });
  }, []);

  const handleSetMessagePingMode = useCallback((mode: MessagePingMode) => {
    postMessage({ type: 'setMessagePingMode', mode });
  }, []);

  if (!guildId) {
    return (
      <Callout variant="warning">
        <strong>Setup Required</strong><br />
        Complete connection setup first (select a server and channel).
      </Callout>
    );
  }

  return (
    <>
      {/* Users to Notify */}
      <Section 
        title="Users to Notify"
        description="Configure which users should be added to threads and notified."
      >
        <textarea 
          rows={3} 
          placeholder="Enter user IDs (one per line or comma-separated)"
          value={userIdsInput}
          onChange={(e) => setUserIdsInput(e.target.value)}
        />
        <Button onClick={handleSaveInviteUsers}>Save User IDs</Button>
        <HelpText>
          To get a user ID: Enable Developer Mode in Discord settings → right-click user → "Copy User ID"
          {threadInviteUserIds.length > 0 && (
            <><br />Currently configured: {threadInviteUserIds.length} user(s)</>
          )}
        </HelpText>
      </Section>

      {/* Thread Creation Notify */}
      <Section 
        title="Thread Creation"
        description="How to notify users when new threads are created."
      >
        <select 
          value={threadCreationNotify} 
          onChange={(e) => handleSetThreadCreationNotify(e.target.value as ThreadCreationNotify)}
        >
          <option value="silent">Add silently (no ping)</option>
          <option value="ping">Add and ping users</option>
        </select>
        <HelpText>
          <strong>Silent:</strong> Users are added to the thread but not pinged.<br />
          <strong>Ping:</strong> Users are added and mentioned so they get notified.
        </HelpText>
      </Section>

      {/* AI Response Pings */}
      <Section 
        title="AI Response Pings"
        description="When should users be pinged for AI responses."
      >
        <select 
          value={messagePingMode} 
          onChange={(e) => handleSetMessagePingMode(e.target.value as MessagePingMode)}
        >
          <option value="never">Don't ping</option>
          <option value="discord_conversation">Ping when replying to Discord message</option>
          <option value="always">Ping on every message</option>
        </select>
        <HelpText>
          <strong>Don't ping:</strong> AI responses are posted without mentions.<br />
          <strong>Discord conversation:</strong> Only ping when responding to a Discord message.<br />
          <strong>Always:</strong> Ping configured users on every AI response.
        </HelpText>
      </Section>
    </>
  );
}
