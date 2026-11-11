import { Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../application/errors';
import { UnitOfWork, type RepositoryScope } from '../../application/ports/repositories';
import { isLockConflict } from './database-errors';
import { MikroOrmRepositoryScope } from './repositories';

// Cada chamada usa um EntityManager novo: identity map isolado e descartado ao final, sem vazamento entre requisições
@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  async transactional<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T> {
    try {
      // READ COMMITTED + lock de linha explícito; o commit acontece só se work resolver
      return await this.orm.em.fork().transactional((em) => work(new MikroOrmRepositoryScope(em)));
    } catch (error) {
      // Lock timeout, deadlock e falha de serialização viram um erro de aplicação transitório
      if (isLockConflict(error)) throw new ConcurrencyConflictError('Concurrent access to the same wallet, retry later', { cause: error });
      throw error;
    }
  }

  read<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T> {
    return work(new MikroOrmRepositoryScope(this.orm.em.fork()));
  }
}
