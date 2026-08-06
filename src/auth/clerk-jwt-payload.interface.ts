export interface ClerkJwtPayload {
  sub: string;
  iss: string;
  azp?: string;
  sid?: string;
  [claim: string]: unknown;
}
