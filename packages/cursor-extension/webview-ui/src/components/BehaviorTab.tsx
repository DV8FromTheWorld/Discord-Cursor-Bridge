import React, { useCallback } from 'react';
import { WebviewState } from '../types';
import { postMessage } from '../vscode';
import styles from './BehaviorTab.module.css';
import { Section, HelpText, Callout } from './shared';

interface Props {
  state: WebviewState;
}

export default function BehaviorTab({ state }: Props) {
  const { guildId, implicitArchiveCount, implicitArchiveHours } = state;

  const handleSetImplicitArchiveCount = useCallback((count: number) => {
    postMessage({ type: 'setImplicitArchiveCount', count });
  }, []);

  const handleSetImplicitArchiveHours = useCallback((hours: number) => {
    postMessage({ type: 'setImplicitArchiveHours', hours });
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
      <Section 
        title="Thread Auto-Archive"
        description="Control when Discord threads should stay active vs. be allowed to auto-archive. Discord auto-archives inactive threads. These settings determine which threads we actively keep open."
      >
        <div className={styles.settingRow}>
          <label className={styles.settingLabel}>Keep top N recent chats active</label>
          <input 
            type="number" 
            value={implicitArchiveCount}
            min={1}
            max={100}
            onChange={(e) => handleSetImplicitArchiveCount(parseInt(e.target.value) || 10)}
          />
          <HelpText>
            Threads for the most recent N chats will always be kept open (reopened if Discord auto-archives them).
          </HelpText>
        </div>

        <div className={styles.settingRow}>
          <label className={styles.settingLabel}>Keep active if used within (hours)</label>
          <input 
            type="number" 
            value={implicitArchiveHours}
            min={1}
            max={720}
            onChange={(e) => handleSetImplicitArchiveHours(parseInt(e.target.value) || 48)}
          />
          <HelpText>
            Threads for chats used within this many hours will be kept open, even if not in the top N.
            Older inactive chats will let Discord's auto-archive stand.
          </HelpText>
        </div>
      </Section>
    </>
  );
}
