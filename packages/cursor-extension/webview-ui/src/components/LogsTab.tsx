import React, { useCallback, useRef, useEffect } from 'react';
import { postMessage } from '../vscode';
import styles from './LogsTab.module.css';
import { Section, Button } from './shared';

interface Props {
  logs: string[];
}

export default function LogsTab({ logs }: Props) {
  const logsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  const handleClearLogs = useCallback(() => {
    postMessage({ type: 'clearLogs' });
  }, []);

  return (
    <Section title="Activity Logs">
      <Button 
        variant="secondary"
        onClick={handleClearLogs}
        className={styles.clearButton}
      >
        Clear Logs
      </Button>
      <div className={styles.logsContainer} ref={logsRef}>
        {logs.length > 0 ? logs.join('\n') : 'No logs yet.'}
      </div>
    </Section>
  );
}
