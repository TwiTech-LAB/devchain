import { useState, useCallback, RefObject } from 'react';

interface Agent {
  id: string;
  name: string;
}

export interface UseMentionAutocompleteResult {
  showAutocomplete: boolean;
  mentionQuery: string;
  selectedIndex: number;
  handleInputChange: (value: string, cursorPosition: number) => void;
  handleKeyDown: (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    currentValue: string,
    setValue: (value: string) => void,
  ) => boolean;
  insertMention: (agent: Agent, currentValue: string) => string;
}

/**
 * Hook to handle @mention autocomplete in textarea
 * - Detects @ character and shows agent suggestions
 * - Handles keyboard navigation (ArrowUp, ArrowDown, Enter, Escape)
 * - Inserts selected agent mention into text
 * @param onSelect - Optional callback fired when agent is selected via Enter key
 */
export function useMentionAutocomplete(
  textareaRef: RefObject<HTMLTextAreaElement>,
  agents: Agent[],
  onSelect?: (agent: Agent) => void,
): UseMentionAutocompleteResult {
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const handleInputChange = useCallback((value: string, cursorPosition: number) => {
    // Find if there's an @ before cursor
    const textBeforeCursor = value.substring(0, cursorPosition);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');

    // Check if @ is present and followed by word characters (no space)
    if (lastAtIndex !== -1) {
      const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1);
      if (!/\s/.test(textAfterAt)) {
        // No space after @, show autocomplete
        setMentionQuery(textAfterAt);
        setShowAutocomplete(true);
        setSelectedIndex(0);
        return;
      }
    }

    // Hide autocomplete if no valid @ found
    setShowAutocomplete(false);
  }, []);

  const insertMention = useCallback(
    (agent: Agent, currentValue: string) => {
      if (!textareaRef.current) return currentValue;

      const textarea = textareaRef.current;
      const cursorPosition = textarea.selectionStart;
      const textBeforeCursor = currentValue.substring(0, cursorPosition);
      const lastAtIndex = textBeforeCursor.lastIndexOf('@');

      if (lastAtIndex === -1) return currentValue;

      // Replace from @ to cursor with @AgentName
      const before = currentValue.substring(0, lastAtIndex);
      const after = currentValue.substring(cursorPosition);
      const newText = `${before}@${agent.name} ${after}`;

      // Hide autocomplete
      setShowAutocomplete(false);
      setMentionQuery('');

      // Set cursor position after the inserted mention
      setTimeout(() => {
        const newCursorPos = lastAtIndex + agent.name.length + 2; // @ + name + space
        textarea.setSelectionRange(newCursorPos, newCursorPos);
        textarea.focus();
      }, 0);

      return newText;
    },
    [textareaRef],
  );

  const handleKeyDown = useCallback(
    (
      e: React.KeyboardEvent<HTMLTextAreaElement>,
      currentValue: string,
      setValue: (value: string) => void,
    ): boolean => {
      if (!showAutocomplete) return false;

      const filteredAgents = agents.filter((agent) =>
        agent.name.toLowerCase().includes(mentionQuery.toLowerCase()),
      );

      switch (e.key) {
        case 'ArrowDown':
          // Guard against empty list to prevent NaN from modulo by zero
          if (filteredAgents.length === 0) return false;
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % filteredAgents.length);
          return true;

        case 'ArrowUp':
          // Guard against empty list to prevent NaN from modulo by zero
          if (filteredAgents.length === 0) return false;
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + filteredAgents.length) % filteredAgents.length);
          return true;

        case 'Enter':
          if (filteredAgents.length > 0) {
            e.preventDefault();
            const selectedAgent = filteredAgents[selectedIndex];
            const newText = insertMention(selectedAgent, currentValue);
            setValue(newText);
            // Fire onSelect callback so component can update selectedAgentIds
            onSelect?.(selectedAgent);
            return true;
          }
          return false;

        case 'Escape':
          e.preventDefault();
          setShowAutocomplete(false);
          setMentionQuery('');
          return true;

        default:
          return false;
      }
    },
    [showAutocomplete, mentionQuery, selectedIndex, agents, insertMention, onSelect],
  );

  return {
    showAutocomplete,
    mentionQuery,
    selectedIndex,
    handleInputChange,
    handleKeyDown,
    insertMention,
  };
}
