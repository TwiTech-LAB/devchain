import type {
  AgentEventBusAnchor,
  AgentEventBusGeometrySnapshot,
  AgentEventBusPath,
  AgentEventBusRuntimeOrigin,
} from './types';

/**
 * Every route takes the same time regardless of how far it travels, so a message to the
 * next agent down and one to the far end of the list share a single rhythm. Longer routes
 * cover more pixels per second rather than lasting longer.
 *
 * This value is the previous minimum-duration floor. Under the old constant-speed model
 * almost every real sidebar route was short enough to sit on that floor already, so short
 * routes are unchanged; only long ones (over ~434px) are quicker than before.
 */
export const EVENT_BUS_ROUTE_DURATION_MS = 6087;
export const EVENT_BUS_CORNER_RADIUS = 10;
export const DEFAULT_BUS_X = 4;
export const EVENT_BUS_GUTTER_RIGHT = 16;
/**
 * How far the overlay extends to the LEFT of the agents panel, in user units. The bus sits
 * at x=4, so without this the left half of the bloom would be cut off at the panel edge.
 * Matches the page gutter between the nav and the panel (the page wrapper's `px-4`), which
 * is also where `main`'s own overflow starts clipping — so it is the most that can show.
 * Paired with `-ml-4` on the sidebar ScrollArea; changing one without the other either
 * re-clips the bloom or shifts every row.
 */
export const EVENT_BUS_GUTTER_LEFT_BLEED = 16;
/**
 * The travelling bloom is a round point light, so a hard clip at the gutter edge would
 * slice it into a visible half-disc. Instead it stays at full strength across the gutter
 * and fades to nothing between `EVENT_BUS_GUTTER_RIGHT` and here, so light falls off onto
 * the card edge rather than being cut.
 */
export const EVENT_BUS_GLOW_FADE_RIGHT = 40;
export const RUNTIME_ORIGIN_Y = 8;

const SVG_PRECISION = 100;

export function roundSvgCoordinate(value: number): number {
  return Math.round(value * SVG_PRECISION) / SVG_PRECISION;
}

function formatSvgNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, '');
}

export function createRoundedOrthogonalPath(
  sourceInput: AgentEventBusAnchor,
  recipientInput: AgentEventBusAnchor,
  busXInput: number,
  radiusInput = EVENT_BUS_CORNER_RADIUS,
): AgentEventBusPath {
  const source = {
    ...sourceInput,
    x: roundSvgCoordinate(sourceInput.x),
    y: roundSvgCoordinate(sourceInput.y),
  };
  const recipient = {
    ...recipientInput,
    x: roundSvgCoordinate(recipientInput.x),
    y: roundSvgCoordinate(recipientInput.y),
  };
  const busX = roundSvgCoordinate(busXInput);
  const maximumRadius = Math.min(
    Math.abs(source.x - busX),
    Math.abs(recipient.x - busX),
    Math.abs(recipient.y - source.y) / 2,
  );
  const radius = roundSvgCoordinate(Math.max(0, Math.min(radiusInput, maximumRadius)));
  const sourceX = formatSvgNumber(source.x);
  const sourceY = formatSvgNumber(source.y);
  const recipientX = formatSvgNumber(recipient.x);
  const recipientY = formatSvgNumber(recipient.y);
  const formattedBusX = formatSvgNumber(busX);

  if (source.y === recipient.y || radius === 0) {
    const d = `M ${sourceX} ${sourceY} H ${formattedBusX} H ${recipientX}`;
    const length = roundSvgCoordinate(Math.abs(source.x - busX) + Math.abs(recipient.x - busX));
    return {
      d,
      length,
      durationMs: EVENT_BUS_ROUTE_DURATION_MS,
      radius,
      source: { ...source, kind: 'agent' },
      recipient,
    };
  }

  const verticalDirection = Math.sign(recipient.y - source.y);
  const sourceHorizontalDirection = Math.sign(busX - source.x);
  const recipientHorizontalDirection = Math.sign(recipient.x - busX);
  const sourceCornerX = roundSvgCoordinate(busX - sourceHorizontalDirection * radius);
  const sourceCornerY = roundSvgCoordinate(source.y + verticalDirection * radius);
  const recipientCornerY = roundSvgCoordinate(recipient.y - verticalDirection * radius);
  const recipientCornerX = roundSvgCoordinate(busX + recipientHorizontalDirection * radius);
  const d = [
    `M ${sourceX} ${sourceY}`,
    `H ${formatSvgNumber(sourceCornerX)}`,
    `Q ${formattedBusX} ${sourceY} ${formattedBusX} ${formatSvgNumber(sourceCornerY)}`,
    `V ${formatSvgNumber(recipientCornerY)}`,
    `Q ${formattedBusX} ${recipientY} ${formatSvgNumber(recipientCornerX)} ${recipientY}`,
    `H ${recipientX}`,
  ].join(' ');
  const length = roundSvgCoordinate(
    Math.abs(source.x - busX) +
      Math.abs(recipient.x - busX) +
      Math.abs(recipient.y - source.y) -
      4 * radius +
      Math.PI * radius,
  );

  return {
    d,
    length,
    durationMs: EVENT_BUS_ROUTE_DURATION_MS,
    radius,
    source: { ...source, kind: 'agent' },
    recipient,
  };
}

export function createRoundedSystemIngressPath(
  recipientInput: AgentEventBusAnchor,
  busXInput: number,
  originYInput = RUNTIME_ORIGIN_Y,
  radiusInput = EVENT_BUS_CORNER_RADIUS,
): AgentEventBusPath {
  const source: AgentEventBusRuntimeOrigin = {
    kind: 'runtime',
    x: roundSvgCoordinate(busXInput),
    y: roundSvgCoordinate(originYInput),
  };
  const recipient = {
    ...recipientInput,
    x: roundSvgCoordinate(recipientInput.x),
    y: roundSvgCoordinate(recipientInput.y),
  };
  const horizontalDistance = Math.abs(recipient.x - source.x);
  const verticalDistance = Math.abs(recipient.y - source.y);
  const radius = roundSvgCoordinate(
    Math.max(0, Math.min(radiusInput, horizontalDistance, verticalDistance)),
  );
  const verticalDirection = Math.sign(recipient.y - source.y) || 1;
  const horizontalDirection = Math.sign(recipient.x - source.x) || 1;
  const cornerStartY = roundSvgCoordinate(recipient.y - verticalDirection * radius);
  const cornerEndX = roundSvgCoordinate(source.x + horizontalDirection * radius);
  const sourceX = formatSvgNumber(source.x);
  const sourceY = formatSvgNumber(source.y);
  const recipientX = formatSvgNumber(recipient.x);
  const recipientY = formatSvgNumber(recipient.y);
  const d =
    radius === 0
      ? `M ${sourceX} ${sourceY} V ${recipientY} H ${recipientX}`
      : [
          `M ${sourceX} ${sourceY}`,
          `V ${formatSvgNumber(cornerStartY)}`,
          `Q ${sourceX} ${recipientY} ${formatSvgNumber(cornerEndX)} ${recipientY}`,
          `H ${recipientX}`,
        ].join(' ');
  const length = roundSvgCoordinate(
    verticalDistance + horizontalDistance - 2 * radius + (Math.PI * radius) / 2,
  );

  return {
    d,
    length,
    durationMs: EVENT_BUS_ROUTE_DURATION_MS,
    radius,
    source,
    recipient,
  };
}

function preferredCopies(
  copies: AgentEventBusAnchor[],
  teamId: string | undefined,
): AgentEventBusAnchor[] {
  if (!teamId) return copies;
  const teamCopies = copies.filter((copy) => copy.teamId === teamId);
  return teamCopies.length > 0 ? teamCopies : copies;
}

export interface SelectedAgentEventBusRoute {
  source: AgentEventBusAnchor;
  recipient: AgentEventBusAnchor;
  path: AgentEventBusPath;
}

export function selectAgentEventBusRoute(
  snapshot: AgentEventBusGeometrySnapshot,
  senderAgentId: string,
  recipientAgentId: string,
  teamId?: string,
): SelectedAgentEventBusRoute | null {
  const senderCopies = snapshot.anchors.filter((anchor) => anchor.agentId === senderAgentId);
  const recipientCopies = snapshot.anchors.filter((anchor) => anchor.agentId === recipientAgentId);
  if (senderCopies.length === 0 || recipientCopies.length === 0) return null;

  const preferredSenders = preferredCopies(senderCopies, teamId);
  const preferredRecipients = preferredCopies(recipientCopies, teamId);
  let selected:
    | {
        source: AgentEventBusAnchor;
        recipient: AgentEventBusAnchor;
        distance: number;
      }
    | undefined;

  for (const source of preferredSenders) {
    for (const recipient of preferredRecipients) {
      const distance = Math.abs(source.y - recipient.y);
      if (
        !selected ||
        distance < selected.distance ||
        (distance === selected.distance &&
          (source.order < selected.source.order ||
            (source.order === selected.source.order && recipient.order < selected.recipient.order)))
      ) {
        selected = { source, recipient, distance };
      }
    }
  }

  if (!selected) return null;
  return {
    source: selected.source,
    recipient: selected.recipient,
    path: createRoundedOrthogonalPath(selected.source, selected.recipient, snapshot.busX),
  };
}

export interface SelectedRuntimeEventBusRoute {
  recipient: AgentEventBusAnchor;
  path: AgentEventBusPath;
}

export function selectRuntimeEventBusRoute(
  snapshot: AgentEventBusGeometrySnapshot,
  recipientAgentId: string,
): SelectedRuntimeEventBusRoute | null {
  let selected: SelectedRuntimeEventBusRoute | null = null;
  for (const recipient of snapshot.anchors) {
    if (recipient.agentId !== recipientAgentId) continue;
    const path = createRoundedSystemIngressPath(
      recipient,
      snapshot.runtimeOrigin.x,
      snapshot.runtimeOrigin.y,
    );
    if (
      !selected ||
      path.length < selected.path.length ||
      (path.length === selected.path.length && recipient.order < selected.recipient.order)
    ) {
      selected = { recipient, path };
    }
  }
  return selected;
}
