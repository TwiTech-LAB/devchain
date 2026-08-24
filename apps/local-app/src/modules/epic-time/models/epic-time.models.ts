export interface EpicTimeSummaryItem {
  activityDate: string;
  agentId: string;
  agentName: string;
  minutes: number;
}

export interface EpicTimeTaskItem {
  epicId: string;
  epicTitle: string;
  isDirect: boolean;
  minutes: number;
}

export interface EpicTimeDetailSummary {
  isRoot: boolean;
  directMinutes: number;
  totalMinutes: number;
  items: EpicTimeSummaryItem[];
  taskItems: EpicTimeTaskItem[];
}

export interface EpicTimeBatchSummaryItem {
  epicId: string;
  totalMinutes: number;
}

export interface EpicTimeBatchSummary {
  items: EpicTimeBatchSummaryItem[];
}
