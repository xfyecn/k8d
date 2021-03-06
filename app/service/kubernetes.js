'use strict';

const Service = require('egg').Service;

class KubernetesService extends Service {


  /**
   * 部署
   * @param {Object} params 
   */
  async deploy(params = {}) {
    const { Deployment, Service: k8sService } = this.ctx.kubernetes;
    const { logger: log, to } = this.app;
    const appCode = params.appCode;
    const deployParams = this.app.getK8sDeployConf({
      image: params.image,
      port: params.port,
      imagePullPolicy: params.imagePullPolicy,
      healthCheck: params.healthCheck,
      envVariables: [],
      appCode: appCode,
      deployMode: 'automatic',
    }, this.config.kubernetes);
    const result = { success: false, message: '' };

    log.info('[kubernetes depoly] create deployment start.', appCode, JSON.stringify(deployParams.deployment));
    // 1. 部署Deployment
    let [err] = await to(Deployment.create({ deployment: deployParams.deployment }));
    if (err) {
      log.error('[kubernetes deploy] create deployment failed.', appCode, err);
      result.message = err.message;
      return result;
    }
    log.info('[kubernetes deploy] create deployment success.', appCode);

    // 2. 创建Service，通过 NodePort 向k8s集群外部暴露服务
    [err] = await to(k8sService.create({ service: deployParams.service }));
    if (err) {
      log.error('[kubernetes deploy] create service failed.', appCode, err);
      // 创建Service失败，删除上个步骤创建的 Deployment 恢复部署的初始状态
      await Deployment.delete({ deploymentName: appCode });
      result.message = err.message;
      return result;
    }
    log.info('[kubernetes deploy] create service success.', appCode);
    log.info('[kubernetes deploy] done success.', appCode);
    result.success = true;
    return result;
  }

  async delete() {

  }

  /**
   * 获取所有Pods、Depployments、Service列表
   * @param filters 筛选条件
   * @returns Object {podStatusMap, deploymentStatusMap} 分别为Pod状态Map和Deployment状态Map
   */
  async getAllStatus(params = {}) {
    const { Pod, Deployment, Service: k8sService } = this.ctx.kubernetes;

    // 获取Deployment列表和Pod列表
    const [podsInfo, deploymentsInfo, servicesInfo] = await Promise.all([
      Pod.info(params.podFilters || {}),
      Deployment.info(params.deploymentFilters || {}),
      k8sService.info(params.serviceFilters || {}),
    ]);

    // Pod状态对应关系
    const podStatusMap = podsInfo.body.items
      .reduce((prev, next) => Object.assign(prev, {
        [next.metadata.labels.app]: {
          // pod的名称
          podName: next.metadata.name,
          // pod状态
          phase: next.status.phase,
          // pod调度情况
          conditions: next.status.conditions,
          // 镜像pull、容器创建情况
          containers: next.status.containerStatuses || [],
        },
      }), {});

    // Deployment状态对应关系
    const deploymentStatusMap = deploymentsInfo.body.items
      .reduce((prev, next) => Object.assign(prev, {
        [next.metadata.name]: {
          // Deployment的名称
          deploymentName: next.metadata.name,
          // Pod创建状态
          conditions: next.status.conditions || [],
        },
      }), {});

    // Service状态对应关系
    const serviceStatusMap = servicesInfo.body.items
      .reduce((prev, next) => Object.assign(prev, {
        [next.metadata.name]: {
          // service透出的端口
          nodePort: next.spec.ports[0].nodePort,
        },
      }), {});

    return { podStatusMap, deploymentStatusMap, serviceStatusMap };
  }

  async monitorServiceState() {

  }

  /**
   * 获取 deployment 列表
   * @param {Object} params 
   */
  async getDeployments(params = {}) {
    const { Deployment } = this.ctx.kubernetes;
    const deployments = await Deployment.info(params);
    if (deployments.statusCode !== 200) {
      this.app.logger.warn('[k8s client]:', deployments);
      return [];
    }
    return deployments.body.items
      .reduce((prev, next) => {
        prev.push({
          metadata: {
            name: next.metadata.name,
            creationTimestamp: next.metadata.creationTimestamp,
          },
          status: {
            replicas:  next.status.replicas,
            availableReplicas: next.status.availableReplicas,
          }
        });
        return prev;
      }, []);
  }


  /**
   * 获取 pod log
   * @param {Object} params
   */
  async getContainerLogs(params = {}) {
    const { Pod } = this.ctx.kubernetes;
    const {podName, containers} = params;
    const containerNameList = params.containers.map(v => {
      // 容器处于running状态才能获取镜像的日志
      if (v.state.running) {
        return v.name;
      }
    }).filter(v => v);
    // 批量获取Pod里各个容器的日志
    const promiseList = containerNameList.map(containerName => Pod.logs({podName, containerName}));
    const promiseRet = await Promise.all(promiseList);
    const containerLogs = [];
    promiseRet.forEach((v, idx) => {
      containerLogs.push('容器 ' + containers[idx]
        + ` 日志内容: (只展示最近${defaultConfig.logOutput.sinceSeconds / 3600}小时的日志且最多显示${defaultConfig.logOutput.tailLines}行) \n`
        + (v.body || '-'));
    });
  
    return containerLogs.join('\n');
  }
}

module.exports = KubernetesService;