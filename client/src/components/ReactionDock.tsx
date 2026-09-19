import React from 'react';
import './ReactionDock.css';

export interface ReactionDockProps {
  selectedEmoji: string;
  onSelect: (emoji: string) => void;
  emojis: string[];
  accentColor?: string;
  direction?: 'row' | 'column';
}

export const ReactionDock: React.FC<ReactionDockProps> = ({
  selectedEmoji,
  onSelect,
  emojis,
  accentColor = '#3b82f6',
  direction = 'row',
}) => {
  const containerClass = direction === 'column'
    ? 'reaction-dock reaction-dock--column'
    : 'reaction-dock';

  return (
    <nav data-no-burst className={containerClass}>
      <span className="reaction-dock__label">REACT:</span>

      {emojis.map((emoji, idx) => {
        const isSelected = selectedEmoji === emoji;
        return (
          <button
            key={emoji}
            type="button"
            className={`reaction-dock__btn ${isSelected ? 'reaction-dock__btn--selected' : ''}`}
            style={{
              borderColor: isSelected ? accentColor : 'transparent',
            }}
            onClick={() => onSelect(emoji)}
            title={`Reaction [${idx + 1}]: ${emoji}`}
          >
            <span>{emoji}</span>
            <span
              className={`reaction-dock__badge ${isSelected ? 'reaction-dock__badge--selected' : ''}`}
            >
              {idx + 1}
            </span>
          </button>
        );
      })}
    </nav>
  );
};
