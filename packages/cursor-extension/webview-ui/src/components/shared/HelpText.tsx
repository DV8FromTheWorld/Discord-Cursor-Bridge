import React from 'react';
import styles from './HelpText.module.css';

interface Props {
  children: React.ReactNode;
}

export default function HelpText({ children }: Props) {
  return <p className={styles.helpText}>{children}</p>;
}
