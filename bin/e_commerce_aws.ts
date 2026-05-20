#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib';
import { ProductsAppStack } from '../lib/productsApp-stack';
import { ECommerceApiStack } from '../lib/ecommerceApi-stack';
import { ProductsAppLayerStack } from '../lib/productAppLayers-stack';

const app = new cdk.App();

const env: cdk.Environment = {
  account: "878670310640",
  region: "us-east-1"
}

const tags = {
  cost: "ECommerce",
  team: "Myteam"
}

const productsAppLayerStack = new ProductsAppLayerStack(app, "ProductsAppLayers", {
  tags: tags,
  env: env
})

const productsAppStack = new ProductsAppStack(app, "ProductsApp", {
  tags: tags,
  env: env
})

productsAppStack.addDependency(productsAppLayerStack)

const eCommerceApiStack = new ECommerceApiStack(app, "ECommerceApi", {
  productsFetchHandler: productsAppStack.productsFetchHandler,
  productsAdminHandler: productsAppStack.productsAdminHandler,
  tags: tags,
  env: env
})
eCommerceApiStack.addDependency(productsAppStack)