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

  if (channels.length === 0) {
    return <div className={styles.empty}>No text channels found in this server.</div>;
  }

  return (
    <div className={styles.list}>
      {groupedChannels.uncategorized.map(c => (
        <div 
          key={c.id} 
          className={styles.item}
          onClick={() => onSelect(c)}
        >
          #{c.name}
        </div>
      ))}
      {Array.from(groupedChannels.grouped.entries()).map(([catName, chans]) => (
        <React.Fragment key={catName}>
          <div className={styles.category}>{catName}</div>
          {chans.map(c => (
            <div 
              key={c.id} 
              className={styles.item}
              onClick={() => onSelect(c)}
            >
              #{c.name}
            </div>
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}
