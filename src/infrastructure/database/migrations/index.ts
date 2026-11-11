import { Migration20261110120000InitialSchema } from './Migration20261110120000InitialSchema';

// Lista explícita das migrations, sem depender de glob em tempo de execução
export const migrationsList = [{ name: 'Migration20261110120000InitialSchema', class: Migration20261110120000InitialSchema }];
