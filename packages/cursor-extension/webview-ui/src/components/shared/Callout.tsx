import React from 'react';
import styles from './Callout.module.css';

type CalloutVariant = 'info' | 'warning';

interface Props {
  variant?: CalloutVariant;
  children: React.ReactNode;
}

export default function Callout({ variant = 'info', children }: Props) {
  const variantClass = variant === 'warning' ? styles.warning : styles.info;
  
  return (
    <div className={`${styles.callout} ${variantClass}`}>
      {children}
    </div>
  );
}
