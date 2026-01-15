import React, { useState, useMemo, useCallback } from 'react';
import { WebviewState, ChannelInfo } from '../types';
import { postMessage } from '../vscode';
import styles from './ConnectionTab.module.css';
import { Section, Row, Button, Callout, HelpText, Tabs, ChannelList } from './shared';

interface Props {
  state: WebviewState;
}

export default function ConnectionTab({ state }: Props) {
  const { 
    hasToken, 
    connected, 
    guildId, 
    guildName, 
    guilds, 
    channels, 
    categories, 
    channelId, 
    channelName, 
    workspaceName, 
    inviteUrl 
  } = state;

  const [tokenInput, setTokenInput] = useState('');
  const [channelTab, setChannelTab] = useState<'create' | 'select'>('create');
  const [newChannelName, setNewChannelName] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');

  const defaultChannelName = useMemo(() => 
    workspaceName.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    [workspaceName]
  );

  const handleSaveToken = useCallback(() => {
    if (tokenInput) {
      postMessage({ type: 'saveToken', token: tokenInput });
      setTokenInput('');
    }
  }, [tokenInput]);

  const handleClearToken = useCallback(() => {
    if (confirm('This will clear your bot token and all settings. Continue?')) {
      postMessage({ type: 'clearToken' });
    }
  }, []);

  const handleSelectGuild = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const option = e.target.selectedOptions[0];
    if (option?.value) {
      postMessage({ 
        type: 'selectGuild', 
        guildId: option.value, 
        guildName: option.dataset.name || '' 
      });
    }
  }, []);

  const handleCreateChannel = useCallback(() => {
    const name = newChannelName || defaultChannelName;
    if (name) {
      postMessage({ 
        type: 'createChannel', 
        channelName: name, 
        categoryId: selectedCategory || undefined 
      });
    }
  }, [newChannelName, defaultChannelName, selectedCategory]);

  const handleSelectChannel = useCallback((channel: ChannelInfo) => {
    postMessage({ 
      type: 'selectChannel', 
      channelId: channel.id, 
      channelName: channel.name 
    });
  }, []);

  const handleClearChannel = useCallback(() => {
    postMessage({ type: 'selectChannel', channelId: '', channelName: '' });
  }, []);

  const handleRefresh = useCallback(() => {
    postMessage({ type: 'refresh' });
  }, []);

  const handleReconnect = useCallback(() => {
    postMessage({ type: 'reconnect' });
  }, []);

  const handleOpenUrl = useCallback((url: string) => {
    postMessage({ type: 'openUrl', url });
  }, []);

  const channelTabs = [
    { id: 'create', label: 'Create New' },
    { id: 'select', label: 'Use Existing' },
  ];

  return (
    <>
      {/* Bot Token Section */}
      <Section 
        title="Bot Token"
        description={
          <>
            Store your Discord bot token securely.{' '}
            <a href="#" onClick={() => handleOpenUrl('https://discord.com/developers/applications')}>
              Get one from Discord Developer Portal
            </a>
          </>
        }
      >
        <input 
          type="password" 
          placeholder={hasToken ? '••••••••••••••••' : 'Enter bot token'}
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSaveToken()}
        />
        <Row>
          <Button onClick={handleSaveToken}>Save Token</Button>
          <span className={hasToken ? styles.success : styles.error}>
            {hasToken ? '✓ Token saved' : '✗ No token'}
          </span>
          {hasToken && (
            <Button 
              variant="danger"
              onClick={handleClearToken}
              className={styles.clearButton}
            >
              Clear Token
            </Button>
          )}
        </Row>
      </Section>

      {/* Guild Selection */}
      {hasToken && (
        <Section 
          title="Discord Server"
          description={
            <>
              Select a server where the bot is installed.{' '}
              {inviteUrl && (
                <a href="#" onClick={() => handleOpenUrl(inviteUrl)}>
                  Add bot to a new server
                </a>
              )}
            </>
          }
        >
          {guilds.length > 0 ? (
            <>
              <select value={guildId || ''} onChange={handleSelectGuild}>
                <option value="">Select a server...</option>
                {guilds.map(g => (
                  <option key={g.id} value={g.id} data-name={g.name}>
                    {g.name}
                  </option>
                ))}
              </select>
              <Row>
                {guildId && <span className={styles.success}>✓ {guildName || 'Server selected'}</span>}
                <Button variant="secondary" onClick={handleRefresh}>Refresh List</Button>
              </Row>
              <HelpText>
                Only servers where the bot is installed appear here.{' '}
                {inviteUrl && (
                  <>
                    <a href="#" onClick={() => handleOpenUrl(inviteUrl)}>
                      Click here to add the bot to another server
                    </a>, then click Refresh.
                  </>
                )}
              </HelpText>
            </>
          ) : connected ? (
            <>
              <Callout variant="warning">
                No servers found. The bot isn't installed in any servers yet.
                {inviteUrl && (
                  <>
                    <br /><br />
                    <a href="#" onClick={() => handleOpenUrl(inviteUrl)}>
                      Click here to add the bot to a server
                    </a>, then click Refresh.
                  </>
                )}
              </Callout>
              <Button variant="secondary" onClick={handleRefresh}>Refresh List</Button>
            </>
          ) : (
            <>
              <p>Waiting for Discord connection...</p>
              <Button variant="secondary" onClick={handleRefresh}>Refresh</Button>
            </>
          )}
        </Section>
      )}

      {/* Channel Selection */}
      {guildId && (
        <Section 
          title="Project Channel"
          description={<>Workspace: <strong>{workspaceName}</strong></>}
        >
          {channelId ? (
            <Row>
              <span className={styles.success}>✓ Using channel: #{channelName || channelId}</span>
              <Button variant="secondary" onClick={handleClearChannel}>Change</Button>
            </Row>
          ) : (
            <>
              <Callout variant="warning">
                <strong>Channel Required</strong><br />
                Select or create a channel to enable the Discord bridge for this workspace.
              </Callout>
              <Tabs 
                tabs={channelTabs}
                activeTab={channelTab}
                onTabChange={(tab) => setChannelTab(tab as 'create' | 'select')}
              />
              
              {channelTab === 'create' && (
                <div className={styles.tabContent}>
                  <input 
                    type="text" 
                    placeholder="Enter channel name" 
                    value={newChannelName}
                    onChange={(e) => setNewChannelName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleCreateChannel()}
                  />
                  {categories.length > 0 && (
                    <select 
                      value={selectedCategory} 
                      onChange={(e) => setSelectedCategory(e.target.value)}
                    >
                      <option value="">No category (root level)</option>
                      {categories.map(c => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  )}
                  <Button onClick={handleCreateChannel}>Create Channel</Button>
                </div>
              )}
              
              {channelTab === 'select' && (
                <div className={styles.tabContent}>
                  <ChannelList channels={channels} onSelect={handleSelectChannel} />
                </div>
              )}
            </>
          )}
        </Section>
      )}

      {/* Actions */}
      <Section title="Actions">
        <Row>
          <Button variant="secondary" onClick={handleReconnect}>Reconnect Bot</Button>
          <Button variant="secondary" onClick={handleRefresh}>Refresh Data</Button>
        </Row>
        <HelpText>
          <strong>Reconnect</strong>: Disconnect and reconnect the Discord bot.<br />
          <strong>Refresh</strong>: Reload server and channel lists from Discord.
        </HelpText>
      </Section>
    </>
  );
}
