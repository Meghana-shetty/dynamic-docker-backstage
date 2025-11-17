import { createBackendModule } from '@backstage/backend-plugin-api';
import { scaffolderActionsExtensionPoint } from '@backstage/plugin-scaffolder-node';
import { createTemplateAction } from '@backstage/plugin-scaffolder-node';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export function createDockerComposeAction() {
  return createTemplateAction({
    id: 'custom:docker-compose',
    description: 'Runs docker compose, removes conflicting containers, rebuilds images, and returns exposed ports',

    schema: {
      input: {
        type: 'object',
        required: ['composeFile'],
        properties: {
          composeFile: { type: 'string' },
          workDir: { type: 'string' },
        },
      },
      output: {
        type: 'object',
        properties: {
          ports: {
            type: 'object',
            description: 'Detected host ports for each service',
            additionalProperties: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  hostPort: { type: 'string' },
                  containerPort: { type: 'string' },
                },
              },
            },
          },
          webUrl: {
            type: 'string',
            description: 'URL of the first web service detected',
          },
        },
      },
    },

    async handler(ctx) {
      const cwd = ctx.input.workDir ?? ctx.workspacePath;
      const composePath = path.join(cwd, ctx.input.composeFile);

      ctx.logger.info(`Compose file: ${composePath}`);

      if (!fs.existsSync(composePath)) {
        throw new Error(`Compose file not found: ${composePath}`);
      }

      // === Step 1: Parse docker-compose.yml to get services ===
      let serviceNames: string[] = [];
      try {
        const yaml = await import('js-yaml');
        const composeContent = fs.readFileSync(composePath, 'utf8');
        const doc = yaml.load(composeContent) as any;
        if (doc.services) {
          serviceNames = Object.keys(doc.services);
          ctx.logger.info(`Detected services: ${serviceNames.join(', ')}`);
        }
      } catch (err) {
        ctx.logger.warn(`Failed to parse compose file: ${err}`);
      }

      // === Step 2: Remove existing containers for those services ===
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

      ctx.logger.info('Starting Docker Compose...');
      // === Step 3: Run docker compose up -d --build ===
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
            ctx.logger.warn(`DOCKER ERR: ${str}`);
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

      // === Step 4: Detect exposed ports ===
      const ports: Record<string, Array<{ hostPort: string; containerPort: string }>> = {};

      for (const service of serviceNames) {
        await new Promise<void>((resolve) => {
          const inspectProc = spawn('/usr/bin/bash', [
            '-c',
            `docker ps --filter "name=${service}" --format "{{.Names}}" | xargs -r -I {} docker port {}`
          ]);

          let output = '';
          inspectProc.stdout.on('data', data => output += data.toString());
          inspectProc.stderr.on('data', data => ctx.logger.warn(`DOCKER WARN: ${data.toString()}`));

          inspectProc.on('close', () => {
            const mappings: Array<{ hostPort: string; containerPort: string }> = [];
            output.split('\n').forEach(line => {
              if (line.trim()) {
                const match = line.match(/^(\d+)\/tcp -> [^:]+:(\d+)$/);
                if (match) {
                  mappings.push({ containerPort: match[1], hostPort: match[2] });
                }
              }
            });
            ports[service] = mappings;
            resolve();
          });
        });
      }

      ctx.logger.info(`Exposed ports: ${JSON.stringify(ports)}`);

      // === Step 5: Pick the first web service URL dynamically ===
      let webUrl = '';
      for (const [service, mappings] of Object.entries(ports)) {
        if (mappings.length > 0) {
          webUrl = `http://localhost:${mappings[0].hostPort}`;
          break; // pick the first service with a port
        }
      }

      ctx.output('ports', ports);
      ctx.logger.info(`Web URL detected: ${webUrl}`);
      ctx.output('webUrl', webUrl);
      //ctx.output('webUrl', webUrl);
      return { webUrl, ports };
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

