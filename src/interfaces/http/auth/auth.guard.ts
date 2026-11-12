import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC_KEY } from "./public.decorator";

// Ponto de extensão da autenticação. Hoje é no-op e libera todas as rotas.
// A integração planejada valida um access token OIDC (Keycloak) e resolve a identidade
// do provedor, que deve bater com o providerId do payload (ver ARCHITECTURE.md).
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;
    // Rotas protegidas: aqui entra a validação do token OIDC quando a autenticação for ligada
    return true;
  }
}
