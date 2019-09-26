'use strict';
const delay = require('delay');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const YAML = require('yamljs');
const mkdirp = require('mkdirp');
var packageJson = require('./package.json');

const unsupportedRegionPrefixes = ['cn-'];

class CreateCertificatePlugin {
  constructor(serverless, options) {
    this.serverless = serverless;
    this.options = options;
    this.initialized = false;
    this.serverless.cli.log(`serverless-certificate-creator version ${packageJson.version} called`);
    this.commands = {
      'create-cert': {
        usage: 'creates a certificate for an existing domain/hosted zone',
        lifecycleEvents: [
          'create'
        ]
      },
    };

    this.hooks = {
      'create-cert:create': this.createCertificate.bind(this),
      'after:deploy:deploy': this.certificateSummary.bind(this),
      'after:info:info': this.certificateSummary.bind(this),
    };

    this.variableResolvers = {
      certificate: {
        resolver: this.getCertificateProperty.bind(this),
        isDisabledAtPrepopulation: true,
        serviceName: 'serverless-certificate-creator depends on AWS credentials.'
      }
    };
  }

  async initializeVariables() {
    if (!this.initialized) {
      this.enabled = this.evaluateEnabled();
      if (this.enabled) {
        const credentials = this.serverless.providers.aws.getCredentials();
        this.route53 = new this.serverless.providers.aws.sdk.Route53(credentials);
        this.region = this.serverless.service.custom.customCertificate.region || 'us-east-1';
        this.domain = this.serverless.service.custom.customCertificate.certificateName;
        //hostedZoneId is mapped for backwards compatibility
        this.hostedZoneIds = this.serverless.service.custom.customCertificate.hostedZoneIds ? this.serverless.service.custom.customCertificate.hostedZoneIds : (this.serverless.service.custom.customCertificate.hostedZoneId) ? [].concat(this.serverless.service.custom.customCertificate.hostedZoneId) : [];
        //hostedZoneName is mapped for backwards compatibility
        this.hostedZoneNames = this.serverless.service.custom.customCertificate.hostedZoneNames ? this.serverless.service.custom.customCertificate.hostedZoneNames : (this.serverless.service.custom.customCertificate.hostedZoneName) ? [].concat(this.serverless.service.custom.customCertificate.hostedZoneName) : [];
        const acmCredentials = Object.assign({}, credentials, { region: this.region });
        this.acm = new this.serverless.providers.aws.sdk.ACM(acmCredentials);
        this.idempotencyToken = this.serverless.service.custom.customCertificate.idempotencyToken;
        this.writeCertInfoToFile = this.serverless.service.custom.customCertificate.writeCertInfoToFile || false;
        this.certInfoFileName = this.serverless.service.custom.customCertificate.certInfoFileName || 'cert-info.yml';
        this.subjectAlternativeNames = this.serverless.service.custom.customCertificate.subjectAlternativeNames || [];
        this.tags = this.serverless.service.custom.customCertificate.tags || {};

        unsupportedRegionPrefixes.forEach(unsupportedRegionPrefix => {
          if (this.region.startsWith(unsupportedRegionPrefix)) {
            console.log(`The configured region ${this.region} does not support ACM. Plugin disabled`);
            this.enabled = false;
          }
        })
      }

      let x = await this.getHostedZoneIds();

      console.log("zones", x);

      return;

      this.initialized = true;
    }
  }



  /**
   * Determines whether this plug-in should be enabled.
   *
   * This method reads the customCertificate property "enabled" to see if this plug-in should be enabled.
   * If the property's value is undefined, a default value of true is assumed (for backwards
   * compatibility).
   * If the property's value is provided, this should be boolean, otherwise an exception is thrown.
   */
  evaluateEnabled() {
    const enabled = this.serverless.service.custom.customCertificate.enabled;
    if (enabled === undefined) {
      return true;
    }
    if (typeof enabled === 'boolean') {
      return enabled;
    } else if (typeof enabled === 'string' && enabled === 'true') {
      return true;
    } else if (typeof enabled === 'string' && enabled === 'false') {
      return false;
    }
    throw new Error(`serverless-certificate-creator: Ambiguous enablement boolean: '${enabled}'`);
  }

  reportDisabled() {
    return Promise.resolve()
      .then(() => this.serverless.cli.log('serverless-certificate-creator: Custom domain is disabled.'));
  }

  listCertificates() {
    return this.acm.listCertificates({}).promise();
  }

  /**
   * tags a certificate
   */
  tagCertificate(certificateArn) {
    let mappedTags = [];
    if (Object.keys(this.tags).length) {
      mappedTags = Object.keys(this.tags).map((tag) => {
        return {
          Key: tag,
          Value: this.tags[tag]
        }
      });
      const params = {
        CertificateArn: certificateArn,
        Tags: mappedTags
      }

      this.serverless.cli.log(`tagging certificate`);
      return this.acm.addTagsToCertificate(params).promise().catch(error => {
        this.serverless.cli.log('tagging certificate failed', error);
        console.log('problem', error);
        throw error;
      });
    }

    return Promise.resolve();
  }

  getExistingCertificate() {
    return this.listCertificates().then(data => {

      let existingCerts = data.CertificateSummaryList.filter(cert => cert.DomainName === this.domain);
      if (existingCerts.length > 0) {
        return existingCerts[0];
      }
      return undefined;
    });
  }

  writeCertificateInfoToFile(certificateArn) {
    if (!this.writeCertInfoToFile) {
      return;
    }
    const info = {
      CertificateArn: certificateArn,
      Domain: this.domain
    }
    try {
      mkdirp.sync(path.dirname(this.certInfoFileName));
      this.serverless.cli.log(`Writing certificate info to ${this.certInfoFileName}`);
      fs.writeFileSync(this.certInfoFileName, YAML.stringify(info));
    } catch (error) {
      this.serverless.cli.log(`Unable to write to ${this.certInfoFileName}`);
      throw error;
    }
  }

  /**
   * Creates a certificate for the given options set in serverless.yml under custom->customCertificate
   */
  createCertificate() {
    this.initializeVariables();
    if (!this.enabled) {
      return this.reportDisabled();
    }
    this.serverless.cli.log(`Trying to create certificate for ${this.domain} in ${this.region} ...`);
    return this.getExistingCertificate().then(existingCert => {


      if (existingCert) {
        this.serverless.cli.log(`Certificate for ${this.domain} in ${this.region} already exists with arn "${existingCert.CertificateArn}". Skipping ...`);
        this.writeCertificateInfoToFile(existingCert.CertificateArn);
        return;
      }

      let params = {
        DomainName: this.domain,
        ValidationMethod: 'DNS',
        IdempotencyToken: this.idempotencyToken,
      };

      if (this.subjectAlternativeNames && this.subjectAlternativeNames.length) {
        params.SubjectAlternativeNames = this.subjectAlternativeNames
      }

      return this.acm.requestCertificate(params).promise().then(requestCertificateResponse => {
        this.serverless.cli.log(`requested cert: ${requestCertificateResponse.CertificateArn}`);

        var params = {
          CertificateArn: requestCertificateResponse.CertificateArn
        };

        return delay(10000).then(() => this.acm.describeCertificate(params).promise().then(certificate => {
          this.serverless.cli.log(`got cert info: ${certificate.Certificate.CertificateArn} - ${certificate.Certificate.Status}`);
          return this.createRecordSetForDnsValidation(certificate)
            .then(() => this.tagCertificate(certificate.Certificate.CertificateArn))
            .then(() => this.waitUntilCertificateIsValidated(certificate.Certificate.CertificateArn));

        }).catch(error => {
          this.serverless.cli.log('could not get cert info', error);
          console.log('problem', error);
          throw error;
        }));


      }).catch(error => {
        this.serverless.cli.log('could not request cert', error);
        console.log('problem', error);
        throw error;
      });


    }).catch(error => {
      this.serverless.cli.log('could not get certs', error);
      console.log('problem', error);
      throw error;
    })
  }

  waitUntilCertificateIsValidated(certificateArn) {
    this.serverless.cli.log('waiting until certificate is validated...');
    var params = {
      CertificateArn: certificateArn /* required */
    };
    return this.acm.waitFor('certificateValidated', params).promise().then(data => {
      this.serverless.cli.log(`cert was successfully created and validated and can be used now`);
      this.writeCertificateInfoToFile(certificateArn);
    }).catch(error => {
      this.serverless.cli.log('certificate validation failed', error);
      console.log('problem', error);
      throw error;
    });
  }

  getHostedZoneIds() {

    return this.route53.listHostedZones({}).promise().then(data => {

      let hostedZones = data.HostedZones.filter(x => this.hostedZoneIds.includes(x.Id.replace(/\/hostedzone\//g, '')) || this.hostedZoneNames.includes(x.Name));

      if (hostedZones.length == 0) {
        throw "no hosted zone for domain found"
      }

      return hostedZones.map(({ Id, Name }) => {
        return { hostedZoneId: Id.replace(/\/hostedzone\//g, ''), Name: Name.substr(0, Name.length - 1) };
      });
    }).catch(error => {
      this.serverless.cli.log('certificate validation failed', error);
      console.log('problem', error);
      throw error;
    });
  }

  /**
   * create the record set required for valdiation type dns. the certificate has the necessary information.
   * at least a short time after the cert has been created, thats why you should delay this call a bit after u created a new cert
   */
  createRecordSetForDnsValidation(certificate) {
    return this.getHostedZoneIds().then((hostedZoneIds) => {

      return Promise.all(hostedZoneIds.map(({ hostedZoneId, Name }) => {
        let changes = certificate.Certificate.DomainValidationOptions.filter(({DomainName}) => DomainName.endsWith(Name)).map((x) => {
          return {
            Action: "CREATE",
            ResourceRecordSet: {
              Name: x.ResourceRecord.Name,
              ResourceRecords: [
                {
                  Value: x.ResourceRecord.Value
                }
              ],
              TTL: 60,
              Type: x.ResourceRecord.Type
            }
          }
        });

        var params = {
          ChangeBatch: {
            Changes: changes,
            Comment: `DNS Validation for certificate ${Name}`
          },
          HostedZoneId: hostedZoneId
        };
        return this.route53.changeResourceRecordSets(params).promise().then(recordSetResult => {
          this.serverless.cli.log('dns validation record(s) created - certificate is ready for use after validation has gone through');
        }).catch(error => {
          this.serverless.cli.log('could not create record set for dns validation', error);
          console.log('problem', error);
          throw error;
        });
      }));
    });
  }

  /**
   * Prints out a summary of all certificate related info
   */
  certificateSummary() {
    this.initializeVariables();
    if (!this.enabled) {
      return this.reportDisabled();
    }
    return this.getExistingCertificate().then(existingCertificate => {
      this.serverless.cli.consoleLog(chalk.yellow.underline('Serverless Certificate Creator Summary'));

      this.serverless.cli.consoleLog(chalk.yellow('Certificate'));
      this.serverless.cli.consoleLog(`  ${existingCertificate.CertificateArn} => ${existingCertificate.DomainName}`);
      return true;
    });
  }

  getCertificateProperty(src) {
    this.initializeVariables();
    let [s, domainName, property] = src.split(':');
    return this.listCertificates()
      .then(({ CertificateSummaryList }) => {
        let cert = CertificateSummaryList.filter(({ DomainName }) => DomainName == domainName)[0];
        if (cert && cert[property]) {
          return cert[property];
        } else {
          this.serverless.cli.consoleLog(chalk.yellow('Warning, certificate or certificate property was not found. Returning an empty string instead!'));
          return '';
        }
      })
      .catch(error => {
        console.log(this.domain, this.region);
        this.serverless.cli.log('Could not find certificate property attempting to create...');
        throw error;
      });
  }
}



module.exports = CreateCertificatePlugin;
