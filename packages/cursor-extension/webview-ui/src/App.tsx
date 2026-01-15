import React, { useState, useEffect, useCallback } from 'react';
import { WebviewState, ExtensionToWebviewMessage } from './types';
import { getVSCodeAPI } from './vscode';
import styles from './App.module.css';
import { StatusIndicator, Callout, Button, Tabs } from './components/shared';
import ConnectionTab from './components/ConnectionTab';
import NotificationsTab from './components/NotificationsTab';
import BehaviorTab from './components/BehaviorTab';
import LogsTab from './components/LogsTab';

type TabId = 'connection' | 'notifications' | 'behavior' | 'logs';

const defaultState: WebviewState = {
  hasToken: false,
  connected: false,
  botUsername: null,
  guildId: null,
  guildName: null,
  guilds: [],
  channels: [],
  categories: [],
  channelId: null,
  channelName: null,
  workspaceName: 'unnamed',
  inviteUrl: null,
  logs: [],
  threadInviteUserIds: [],
  threadCreationNotify: 'silent',
  messagePingMode: 'never',
  implicitArchiveCount: 10,
  implicitArchiveHours: 48,
};

const MAIN_TABS = [
  { id: 'connection', label: 'Connection' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'behavior', label: 'Behavior' },
  { id: 'logs', label: 'Logs' },
];

export default function App() {
  const [state, setState] = useState<WebviewState>(() => {
    const savedState = getVSCodeAPI().getState();
    return savedState || defaultState;
  });
  
  const [activeTab, setActiveTab] = useState<TabId>('connection');

  useEffect(() => {
    const handleMessage = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      const message = event.data;
      
      switch (message.type) {
        case 'stateUpdate':
          setState(prev => {
            const newState = { ...prev, ...message.state };
            getVSCodeAPI().setState(newState);
            return newState;
          });
          break;
          
        case 'logsUpdate':
          setState(prev => {
            const newState = { ...prev, logs: message.logs };
            getVSCodeAPI().setState(newState);
            return newState;
          });
          break;
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleTabChange = useCallback((tab: string) => {
    setActiveTab(tab as TabId);
  }, []);

  const { hasToken, connected, botUsername, guildId } = state;

  const getConnectionStatus = () => {
    if (connected) return 'connected';
    if (hasToken) return 'pending';
    return 'disconnected';
  };

  const getConnectionText = () => {
    if (connected) return `Connected as ${botUsername || 'bot'}`;
    if (hasToken) return 'Connecting...';
    return 'Not configured';
  };

  const tabs = MAIN_TABS.map(tab => ({
    ...tab,
    disabled: (tab.id === 'notifications' || tab.id === 'behavior') && !guildId,
  }));

  return (
    <div className={styles.app}>
      <h2 className={styles.header}>Discord Bridge</h2>

      <div className={styles.status}>
        <StatusIndicator status={getConnectionStatus()}>
          {getConnectionText()}
        </StatusIndicator>
        {!connected && hasToken && (
          <div className={styles.statusActions}>
            <Button 
              variant="secondary"
              onClick={() => getVSCodeAPI().postMessage({ type: 'reconnect' })}
            >
              Retry
            </Button>
          </div>
        )}
      </div>

      {!hasToken && (
        <Callout variant="warning">
          <strong>Setup Required</strong><br />
          Enter your Discord bot token below to get started. You can create a bot at the{' '}
          <a href="#" onClick={() => getVSCodeAPI().postMessage({ type: 'openUrl', url: 'https://discord.com/developers/applications' })}>
            Discord Developer Portal
          </a>.
        </Callout>
      )}

      <Tabs 
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={handleTabChange}
        variant="main"
      />

      <div className={styles.tabPanels}>
        {activeTab === 'connection' && <ConnectionTab state={state} />}
        {activeTab === 'notifications' && <NotificationsTab state={state} />}
        {activeTab === 'behavior' && <BehaviorTab state={state} />}
        {activeTab === 'logs' && <LogsTab logs={state.logs} />}
      </div>
    </div>
  );
}
