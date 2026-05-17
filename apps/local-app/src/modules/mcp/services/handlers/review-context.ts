import type { ReviewStorage, AgentStorage } from '../../../storage/interfaces/storage.interface';
import type { ReviewsService } from '../../../reviews/services/reviews.service';
import type { ReviewSuggestionApplier } from '../../../reviews/services/review-suggestion-applier.service';
import type { McpResponse } from '../../dtos/mcp.dto';

export type ReviewToolStorage = ReviewStorage & AgentStorage;

export interface ReviewToolContext {
  storage: ReviewToolStorage;
  reviewsService: ReviewsService;
  reviewSuggestionApplier: ReviewSuggestionApplier;
  resolveSessionContext: (sessionId: string) => Promise<McpResponse>;
}
