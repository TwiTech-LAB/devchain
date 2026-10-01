import { Body, Controller, HttpCode, HttpStatus, Put } from '@nestjs/common';
import { z } from 'zod';
import { InstanceLabelService } from '../services/instance-label.service';

// Mirrors the remote-name limit at home (UpdateRemoteNameSchema): the label is
// the name home gave the remote, and an empty label clears it.
const SetInstanceLabelSchema = z
  .object({
    label: z.string().max(128),
  })
  .strict();

@Controller('api/cloud')
export class InstanceLabelController {
  constructor(private readonly instanceLabel: InstanceLabelService) {}

  @Put('instance-label')
  @HttpCode(HttpStatus.OK)
  async setLabel(@Body() body: unknown): Promise<{ label: string | null }> {
    // A ZodError becomes the standard 400 in the global exception filter.
    const { label } = SetInstanceLabelSchema.parse(body);
    return { label: await this.instanceLabel.setLabel(label) };
  }
}
