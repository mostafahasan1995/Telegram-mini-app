/**
 * `GET /v1/system/egress-status` — the number one question at 2am on a Cloudflare-blocked box:
 * "whose IP is actually leaving this server, and is the VPN carrying it?"
 *
 * Controllers in this tree are protected by the global JWT guard by default, and this one is left
 * that way on purpose: it answers with the deployment's public IP and VPN state, which is real
 * operational intelligence and is not in the same class as the unauthenticated liveness endpoint.
 * The dashboard's settings screen already holds a bearer token, so nothing about the UX changes.
 */
import { Controller, Get } from '@nestjs/common';

import { type EgressStatusPayload, EgressStatusService } from './egress-status.service';

@Controller('v1/system')
export class EgressStatusController {
  constructor(private readonly egress: EgressStatusService) {}

  @Get('egress-status')
  status(): Promise<EgressStatusPayload> {
    return this.egress.status();
  }
}