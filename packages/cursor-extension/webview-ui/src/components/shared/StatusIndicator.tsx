import React from 'react';
import styles from './StatusIndicator.module.css';

type Status = 'connected' | 'pending' | 'disconnected';

interface Props {
  status: Status;
  children: React.ReactNode;
}

export default function StatusIndicator({ status, children }: Props) {
  const statusClass = {
    connected: styles.connected,
    pending: styles.pending,
    disconnected: styles.disconnected,
  }[status];

  return (
    <div className={styles.container}>
      <div className={`${styles.dot} ${statusClass}`} />
      <span>{children}</span>
    </div>
  );
}
