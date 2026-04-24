import type { PillarConfig } from '../config/index.js';
import type { MigrationAdapter } from './types.js';
import { PrismaAdapter } from './adapters/prisma.js';
import { DrizzleAdapter } from './adapters/drizzle.js';
import { TypeOrmAdapter } from './adapters/typeorm.js';
import { MongooseAdapter } from './adapters/mongoose.js';
import { NoneAdapter } from './adapters/none.js';

/**
 * Pick the migration adapter for a Pillar project, driven by
 * `config.database.orm`. Returning a `NoneAdapter` for unconfigured
 * projects (rather than throwing) preserves the "every command resolves
 * to either runnable plan or typed unsupported" invariant — the CLI
 * doesn't need a second error path for the "no ORM" case.
 */
export function selectAdapter(config: PillarConfig): MigrationAdapter {
  switch (config.database.orm) {
    case 'prisma':
      return new PrismaAdapter();
    case 'drizzle':
      return new DrizzleAdapter();
    case 'typeorm':
      return new TypeOrmAdapter();
    case 'mongoose':
      return new MongooseAdapter();
    case 'none':
    default:
      return new NoneAdapter();
  }
}
