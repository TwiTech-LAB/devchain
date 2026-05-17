import type { ToolBindingEntry } from './types';
import {
  handleListReviews,
  handleGetReview,
  handleGetReviewComments,
  handleReplyComment,
  handleResolveComment,
  handleApplySuggestion,
} from '../services/handlers/review-tools';

export const reviewBindings: ToolBindingEntry[] = [
  ['devchain_list_reviews', handleListReviews as unknown as ToolBindingEntry[1]],
  ['devchain_get_review', handleGetReview as unknown as ToolBindingEntry[1]],
  ['devchain_get_review_comments', handleGetReviewComments as unknown as ToolBindingEntry[1]],
  ['devchain_reply_comment', handleReplyComment as unknown as ToolBindingEntry[1]],
  ['devchain_resolve_comment', handleResolveComment as unknown as ToolBindingEntry[1]],
  ['devchain_apply_suggestion', handleApplySuggestion as unknown as ToolBindingEntry[1]],
];
