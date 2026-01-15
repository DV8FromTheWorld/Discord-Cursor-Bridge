import React, { useMemo } from 'react';
import { ChannelInfo } from '../../types';
import styles from './ChannelList.module.css';

interface Props {
  channels: ChannelInfo[];
  onSelect: (channel: ChannelInfo) => void;
}

export default function ChannelList({ channels, onSelect }: Props) {
  const groupedChannels = useMemo(() => {
    const grouped = new Map<string, ChannelInfo[]>();
    const uncategorized: ChannelInfo[] = [];
    
    channels.forEach(c => {
      if (c.categoryName) {
        const cat = grouped.get(c.categoryName) || [];
        cat.push(c);
        grouped.set(c.categoryName, cat);
      } else {
        uncategorized.push(c);
      }
    });
    
    return { grouped, uncategorized };
  }, [channels]);

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const channelId = e.target.value;
    if (!channelId) return;
    
    const channel = channels.find(c => c.id === channelId);
    if (channel) {
      onSelect(channel);
    }
  };

  if (channels.length === 0) {
    return <div className={styles.empty}>No text channels found in this server.</div>;
  }

  return (
    <select className={styles.select} onChange={handleChange} defaultValue="">
      <option value="">Select a channel...</option>
      
      {groupedChannels.uncategorized.length > 0 && (
        <optgroup label="Channels">
          {groupedChannels.uncategorized.map(c => (
            <option key={c.id} value={c.id}>
              # {c.name}
            </option>
          ))}
        </optgroup>
      )}
      
      {Array.from(groupedChannels.grouped.entries()).map(([catName, chans]) => (
        <optgroup key={catName} label={catName}>
          {chans.map(c => (
            <option key={c.id} value={c.id}>
              # {c.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
