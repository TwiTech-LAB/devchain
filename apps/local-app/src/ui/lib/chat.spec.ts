import { parseMentions } from './chat';

describe('parseMentions', () => {
  const agents = [
    { id: 'agent-1', name: 'Agent Alpha' },
    { id: 'agent-2', name: 'Agent Beta' },
  ];

  it('resolves mentions case-insensitively', () => {
    const result = parseMentions('Hello @agent alpha and @AGENT BETA!', agents);
    expect(result).toEqual(['agent-1', 'agent-2']);
  });

  it('ignores unknown handles', () => {
    const result = parseMentions('Ping @Unknown and @agent alpha', agents);
    expect(result).toEqual(['agent-1']);
  });

  it('removes duplicate mentions', () => {
    const result = parseMentions('@Agent Alpha thanks @agent alpha', agents);
    expect(result).toEqual(['agent-1']);
  });

  it('does not match partial tokens', () => {
    const result = parseMentions('Heads up @Agent', agents);
    expect(result).toEqual([]);
  });
});
