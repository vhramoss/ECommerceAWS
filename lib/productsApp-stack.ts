import * as lambda from "aws-cdk-lib/aws-lambda"
import * as lambdaNodeJS from "aws-cdk-lib/aws-lambda-nodejs"
import * as cdk from "aws-cdk-lib"
import * as dynamodb from "aws-cdk-lib/aws-dynamodb"
import { Construct } from "constructs"
import * as ssm from "aws-cdk-lib/aws-ssm"
import * as iam from "aws-cdk-lib/aws-iam"

interface ProductsAppStackProps extends cdk.StackProps {
    eventsDdb: dynamodb.Table
}

export class ProductsAppStack extends cdk.Stack {
    readonly productsFetchHandler: lambdaNodeJS.NodejsFunction
    readonly productsAdminHandler: lambdaNodeJS.NodejsFunction
    readonly productsDdb: dynamodb.Table
    

    constructor(scope: Construct, id: string, props: ProductsAppStackProps) {
        super(scope, id, props)

        this.productsDdb = new dynamodb.Table(this, "ProdcutsDdb", {
            tableName: "products",
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            partitionKey: {
                name: "id",
                type: dynamodb.AttributeType.STRING
            },
            billingMode: dynamodb.BillingMode.PROVISIONED,
            readCapacity: 1,
            writeCapacity: 1
        })

        //Products Layer
        const productsLayerArn = ssm.StringParameter.valueForStringParameter(this, "ProductsLayerVersionArn")
        const productsLayer = lambda.LayerVersion.fromLayerVersionArn(this, "ProductsLayerVersionArn", productsLayerArn)
        
        //Products Events Layer
        const productEventsLayerArn = ssm.StringParameter.valueForStringParameter(this, "ProductEventsLayerVersionArn")
        const productEventsLayer = lambda.LayerVersion.fromLayerVersionArn(this, "ProductEventsLayerVersionArn", productEventsLayerArn)

        const productsEventHandler = new lambdaNodeJS.NodejsFunction(this,"ProductEventsFunction", {
            runtime: lambda.Runtime.NODEJS_20_X,
            functionName: "ProductEventsFunction",
            entry: "lambda/products/productEventsFunction.ts",
            handler: "handler",
            memorySize: 512,
            timeout: cdk.Duration.seconds(2),
            bundling: {
                minify: true,
                sourceMap: false,
                nodeModules: [
                    'aws-xray-sdk-core'
                ],
            },

            environment: {
                EVENTS_DDB: props.eventsDdb.tableName
            },
            tracing: lambda.Tracing.ACTIVE,
            insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_498_0
        })

            const putItemPolicy = new iam.PolicyStatement({
                    effect: iam.Effect.ALLOW,
                    actions: ["dynamodb:PutItem"],
                    resources: [props.eventsDdb.tableArn],
                    conditions: {
                        ['ForAllValues:StringLike']: {
                            'dynamodb:LeadingKeys': ['#product_*']
                        }
                    }
                })
        productsEventHandler.addToRolePolicy(putItemPolicy)

        this.productsFetchHandler = new lambdaNodeJS.NodejsFunction(this,"ProductsFetchFunction", {
            runtime: lambda.Runtime.NODEJS_20_X,
            functionName: "ProductsFetchFunction",
            entry: "lambda/products/productsFetchFunction.ts",
            handler: "handler",
            memorySize: 512,
            timeout: cdk.Duration.seconds(5),
            bundling: {
                minify: true,
                sourceMap: false,
                nodeModules: [
                    'aws-xray-sdk-core'
                ],
            },

            environment: {
                PRODUCTS_DDB: this.productsDdb.tableName
            },
            layers: [productsLayer], 
            tracing: lambda.Tracing.ACTIVE,
            insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_498_0
        })

        this.productsDdb.grantReadData(this.productsFetchHandler)

        this.productsAdminHandler = new lambdaNodeJS.NodejsFunction(this,"ProductsAdminFunction", {
            runtime: lambda.Runtime.NODEJS_20_X,
            functionName: "ProductsAdminFunction",
            entry: "lambda/products/productsAdminFunction.ts",
            handler: "handler",
            memorySize: 512,
            timeout: cdk.Duration.seconds(5),
            bundling: {
                minify: true,
                sourceMap: false,
                nodeModules: [
                    'aws-xray-sdk-core'
                ],   
            },
            environment: {
                PRODUCTS_DDB: this.productsDdb.tableName,
                PRODUCT_EVENTS_FUNCTION_NAME: productsEventHandler.functionName
            },
            layers: [productsLayer, productEventsLayer],
            tracing: lambda.Tracing.ACTIVE,
            insightsVersion: lambda.LambdaInsightsVersion.VERSION_1_0_498_0
        })

        this.productsDdb.grantWriteData(this.productsAdminHandler)
        productsEventHandler.grantInvoke(this.productsAdminHandler)
    }
}