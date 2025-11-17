create runDockerCompose.ts in /home/msis/dockerdynamicbackstage/packages/backend/src/custom-actions
create scaffolder-shell-module.ts in /home/msis/dockerdynamicbackstage/packages/backend/src

i did below commands:

docker network prune
sudo systemctl restart docker

//stopping the previous containers

docker stop mompopcafeapp
docker stop mysql

//removing
docker rm -f mysql
docker rm -f mompopcafeapp
