import { Module } from '@nestjs/common';
import { getEnvConfig } from '../../common/config/env.config';
import { EpicsModule } from '../epics/epics.module';
import { RealtimeBroadcastModule } from '../realtime/realtime-broadcast.module';
import { isClaimedHost } from '../remotes/host-api-key';
import { SettingsModule } from '../settings/settings.module';
import { ProcessExecutorModule } from '../terminal/services/process-executor/process-executor.module';
import { GITHUB_STAR_GH } from './github-star-gh.port';
import { GithubStarCliService } from './github-star-cli.service';
import { GithubStarController } from './github-star.controller';
import { GITHUB_STAR_ON_VM, GithubStarService } from './github-star.service';

@Module({
  imports: [SettingsModule, EpicsModule, RealtimeBroadcastModule, ProcessExecutorModule],
  controllers: [GithubStarController],
  providers: [
    GithubStarService,
    { provide: GITHUB_STAR_GH, useClass: GithubStarCliService },
    {
      provide: GITHUB_STAR_ON_VM,
      useValue: () => isClaimedHost(getEnvConfig().DEVCHAIN_HOST_ETC_DIR),
    },
  ],
})
export class GithubStarModule {}
