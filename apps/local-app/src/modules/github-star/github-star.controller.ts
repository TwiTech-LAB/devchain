import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  GithubStarActionRequestSchema,
  type GithubStarActionResponse,
  type GithubStarStateResponse,
} from './github-star.dto';
import { GithubStarService } from './github-star.service';

@Controller('api/github-star')
export class GithubStarController {
  constructor(private readonly githubStar: GithubStarService) {}

  @Get()
  getState(): GithubStarStateResponse {
    return this.githubStar.getState();
  }

  /** An action for a prompt that is no longer pending changes nothing and returns the current state. */
  @Post('action')
  @HttpCode(HttpStatus.OK)
  async act(@Body() body: unknown): Promise<GithubStarActionResponse> {
    const { promptId, action } = GithubStarActionRequestSchema.parse(body);
    return this.githubStar.applyAction(promptId, action);
  }
}
