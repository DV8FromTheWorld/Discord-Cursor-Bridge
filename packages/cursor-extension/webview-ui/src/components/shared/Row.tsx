import React from 'react';
import styles from './Row.module.css';

interface Props {
  children: React.ReactNode;
  className?: string;
}

export default function Row({ children, className }: Props) {
  return (
    <div className={`${styles.row} ${className || ''}`}>
      {children}
    </div>
  );
}
