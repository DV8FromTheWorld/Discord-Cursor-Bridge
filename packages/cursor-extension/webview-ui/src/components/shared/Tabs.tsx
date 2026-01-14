import React from 'react';
import styles from './Tabs.module.css';

interface Tab {
  id: string;
  label: string;
  disabled?: boolean;
}

interface Props {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  variant?: 'main' | 'sub';
}

export default function Tabs({ tabs, activeTab, onTabChange, variant = 'sub' }: Props) {
  const containerClass = variant === 'main' ? styles.mainTabs : styles.subTabs;
  const tabClass = variant === 'main' ? styles.mainTab : styles.subTab;
  const activeClass = variant === 'main' ? styles.mainTabActive : styles.subTabActive;

  return (
    <div className={containerClass}>
      {tabs.map(tab => (
        <button
          key={tab.id}
          className={`${tabClass} ${activeTab === tab.id ? activeClass : ''}`}
          onClick={() => onTabChange(tab.id)}
          disabled={tab.disabled}
          style={tab.disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
