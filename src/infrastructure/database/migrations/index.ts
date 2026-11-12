import { Migration20261110120000InitialSchema } from './Migration20261110120000InitialSchema';
import { Migration20261112120000OutboxSequence } from './Migration20261112120000OutboxSequence';
import { Migration20261112130000DropOutboxSequenceUnique } from './Migration20261112130000DropOutboxSequenceUnique';

// Lista explícita das migrations, sem depender de glob em tempo de execução
export const migrationsList = [
  { name: 'Migration20261110120000InitialSchema', class: Migration20261110120000InitialSchema },
  { name: 'Migration20261112120000OutboxSequence', class: Migration20261112120000OutboxSequence },
  { name: 'Migration20261112130000DropOutboxSequenceUnique', class: Migration20261112130000DropOutboxSequenceUnique },
];
