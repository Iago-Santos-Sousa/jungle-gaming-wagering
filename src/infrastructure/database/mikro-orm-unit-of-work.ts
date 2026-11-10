import { Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { UnitOfWork, type RepositoryScope } from '../../application/ports/repositories';
import { MikroOrmRepositoryScope } from './repositories';

// Cada chamada usa um EntityManager novo: identity map isolado e descartado ao final, sem vazamento entre requisições
@Injectable()
export class MikroOrmUnitOfWork extends UnitOfWork {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  transactional<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T> {
    // READ COMMITTED + lock de linha explícito; o commit acontece só se work resolver
    return this.orm.em.fork().transactional((em) => work(new MikroOrmRepositoryScope(em)));
  }

  read<T>(work: (scope: RepositoryScope) => Promise<T>): Promise<T> {
    return work(new MikroOrmRepositoryScope(this.orm.em.fork()));
  }
}
