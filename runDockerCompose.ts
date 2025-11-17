import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export function createDockerComposeAction() {
  return createTemplateAction({
    id: 'custom:docker-compose',
    description: 'Runs docker compose from a provided compose file, rebuilds images, and removes conflicting containers automatically',

    schema: {
      input: {
        type: 'object',
        required: ['composeFile'],
        properties: {
          composeFile: { type: 'string' },
          workDir: { type: 'string' },
        },
      },
    },

    async handler(ctx) {
      const cwd = ctx.input.workDir ?? ctx.workspacePath;
      const composePath = path.join(cwd, ctx.input.composeFile);

      ctx.logger.info(`composeFile from user: ${ctx.input.composeFile}`);
      ctx.logger.info(`Workspace path: ${cwd}`);
      ctx.logger.info(`Resolved composePath: ${composePath}`);

      if (!fs.existsSync(composePath)) {
        ctx.logger.error(`Compose file NOT FOUND at: ${composePath}`);
        throw new Error(`Compose file not found: ${composePath}`);
      }

      // === Step 0: Parse compose file to get service names ===
      let serviceNames: string[] = [];
      try {
        const yaml = await import('js-yaml');
        const composeContent = fs.readFileSync(composePath, 'utf8');
        const doc = yaml.load(composeContent) as any;
        if (doc.services) {
          serviceNames = Object.keys(doc.services);
          ctx.logger.info(`Detected services in compose file: ${serviceNames.join(', ')}`);
        }
      } catch (err) {
        ctx.logger.warn(`Failed to parse compose file for service names: ${err}`);
      }

      // === Step 1: Remove any existing containers that match service names ===
      for (const service of serviceNames) {
        await new Promise<void>((resolve) => {
          const rmProc = spawn('/usr/bin/bash', [
            '-c',
            `docker ps -a --filter "name=${service}" --format "{{.Names}}" | xargs -r docker rm -f`
          ]);

          rmProc.stdout.on('data', data => ctx.logger.info(`DOCKER OUT: ${data.toString()}`));
          rmProc.stderr.on('data', data => ctx.logger.warn(`DOCKER WARN: ${data.toString()}`));

          rmProc.on('close', () => {
            ctx.logger.info(`Removed any existing containers matching: ${service}`);
            resolve();
          });
        });
      }

      ctx.logger.info(`Starting Docker Compose with rebuild...`);

      // === Step 2: Run docker compose up -d --build ===
      await new Promise<void>((resolve, reject) => {
        const upProc = spawn(
          '/usr/bin/docker',
          ['compose', '-f', composePath, 'up', '-d', '--build'],
          { cwd }
        );

        upProc.stdout.on('data', data => ctx.logger.info(`DOCKER OUT: ${data.toString()}`));
        upProc.stderr.on('data', data => {
          const str = data.toString();
          if (str.includes('Creating') || str.includes('Created') || str.includes('level=warning')) {
            ctx.logger.warn(`DOCKER WARN: ${str}`);
          } else {
            ctx.logger.error(`DOCKER ERR: ${str}`);
          }
        });

        upProc.on('close', code => {
          if (code === 0) {
            ctx.logger.info('Docker Compose executed successfully.');
            resolve();
          } else {
            ctx.logger.error(`docker compose up exited with code ${code}`);
            reject(new Error(`docker compose up exited with code ${code}`));
          }
        });
      });
    },
  });
}

export const dockerComposeModule = createBackendModule({
  moduleId: 'docker-compose-actions',
  pluginId: 'scaffolder',
  register(env) {
    env.registerInit({
      deps: { scaffolder: scaffolderActionsExtensionPoint },
      async init({ scaffolder }) {
        scaffolder.addActions(createDockerComposeAction());
      },
    });
  },
});
