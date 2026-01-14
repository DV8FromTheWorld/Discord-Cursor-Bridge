import React from 'react';
import styles from './Section.module.css';

interface Props {
  title?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}

export default function Section({ title, description, children }: Props) {
  return (
    <div className={styles.section}>
      {title && <label className={styles.title}>{title}</label>}
      {description && <div className={styles.description}>{description}</div>}
      {children}
    </div>
  );
}
